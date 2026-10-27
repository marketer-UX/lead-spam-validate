// Package verify wraps the AfterShip email-verifier library.
//
// Two long-lived verifier instances are created exactly once: fast never opens
// an SMTP connection (stage 1, must stay fast enough for a synchronous form
// submit), deep does the full SMTP + catch-all handshake (stage 2, may take
// seconds). Keeping them apart makes it impossible for the SMTP check to leak
// into the synchronous path.
//
// Deep checks are throttled per MX host: one connection at a time per host and
// at least MinHostSpacing between two starts, plus a global cap of
// MaxGlobalDeep concurrent checks. Mail servers greylist or blocklist senders
// that hammer them; this is what keeps our IP reputation intact.
package verify

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"time"

	ev "github.com/AfterShip/email-verifier"
)

const (
	// MaxQueueWait caps how long a deep check waits for a throttle slot
	// before it gives up and reports "unknown" to the caller.
	MaxQueueWait = 20 * time.Second
	// MinHostSpacing is the minimum distance between two deep checks that
	// hit the same MX host.
	MinHostSpacing = 1 * time.Second
	// MaxGlobalDeep is how many deep checks may run at the same time.
	MaxGlobalDeep = 10
	// ConnectTimeout / OperationTimeout are handed to the deep verifier.
	ConnectTimeout   = 5 * time.Second
	OperationTimeout = 8 * time.Second

	mxLookupTimeout = 3 * time.Second
	mxCacheTTL      = 5 * time.Minute
)

// ErrThrottleTimeout is returned when a deep check waited MaxQueueWait for a
// free slot. The handler turns it into a fail-open "unknown" response.
var ErrThrottleTimeout = errors.New("throttle_timeout")

// ErrNotInitialised means Init was never called.
var ErrNotInitialised = errors.New("verifier not initialised")

var (
	once sync.Once
	fast *ev.Verifier // stage 1: no SMTP
	deep *ev.Verifier // stage 2: with SMTP

	globalSem = make(chan struct{}, MaxGlobalDeep)

	// gates and mxCache grow by one small entry per distinct MX host /
	// domain and are never evicted. Bounded in practice by the number of
	// mail providers we ever see - a few thousand entries, some hundred kB.
	gatesMu sync.Mutex
	gates   = make(map[string]*hostGate)

	mxCache sync.Map // domain -> mxEntry
)

type hostGate struct {
	sem       chan struct{} // capacity 1: one deep check per MX host
	mu        sync.Mutex
	lastStart time.Time
}

type mxEntry struct {
	host    string
	expires time.Time
}

// Init builds both verifier instances. Safe to call more than once; only the
// first call has an effect.
func Init(fromEmail, helloName string) {
	once.Do(func() {
		// Stage 1 - synchronous, has to stay well under 100 ms.
		fast = ev.NewVerifier().
			DisableSMTPCheck().
			DisableCatchAllCheck().
			EnableDomainSuggest().
			EnableAutoUpdateDisposable()

		// Stage 2 - asynchronous, may take seconds.
		deep = ev.NewVerifier().
			EnableSMTPCheck().
			EnableCatchAllCheck().
			EnableDomainSuggest().
			EnableAutoUpdateDisposable().
			FromEmail(fromEmail).
			HelloName(helloName).
			ConnectTimeout(ConnectTimeout).
			OperationTimeout(OperationTimeout)
	})
}

// Fast runs the stage 1 check (syntax, MX, disposable, role, free, suggestion).
func Fast(email string) (*ev.Result, error) { return FastContext(context.Background(), email) }

// Deep runs the stage 2 check including the SMTP and catch-all handshake.
func Deep(email string) (*ev.Result, error) { return DeepContext(context.Background(), email) }

// FastContext is Fast, but gives up as soon as ctx is done.
func FastContext(ctx context.Context, email string) (*ev.Result, error) {
	if fast == nil {
		return nil, ErrNotInitialised
	}
	return runWithContext(ctx, func() (*ev.Result, error) { return fast.Verify(email) }, nil)
}

// DeepContext is Deep, but respects ctx and waits for a throttle slot first.
func DeepContext(ctx context.Context, email string) (*ev.Result, error) {
	if deep == nil {
		return nil, ErrNotInitialised
	}

	release, err := acquire(ctx, throttleKey(ctx, email))
	if err != nil {
		return nil, err
	}

	// release runs when the library call actually returns, not when the
	// caller walks away - otherwise a timed-out request would free the host
	// slot while its connection is still open.
	return runWithContext(ctx, func() (*ev.Result, error) { return deep.Verify(email) }, release)
}

func runWithContext(ctx context.Context, call func() (*ev.Result, error), done func()) (*ev.Result, error) {
	type outcome struct {
		res *ev.Result
		err error
	}
	ch := make(chan outcome, 1)

	go func() {
		if done != nil {
			defer done()
		}
		res, err := call()
		ch <- outcome{res, err}
	}()

	select {
	case o := <-ch:
		return o.res, o.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// acquire takes the global slot, then the per-host slot, then waits out the
// remaining host spacing. The returned func gives everything back exactly once.
func acquire(ctx context.Context, host string) (func(), error) {
	qctx, cancel := context.WithTimeout(ctx, MaxQueueWait)
	defer cancel()

	select {
	case globalSem <- struct{}{}:
	case <-qctx.Done():
		return nil, queueErr(ctx)
	}

	g := gateFor(host)
	select {
	case g.sem <- struct{}{}:
	case <-qctx.Done():
		<-globalSem
		return nil, queueErr(ctx)
	}

	g.mu.Lock()
	wait := MinHostSpacing - time.Since(g.lastStart)
	g.mu.Unlock()

	if wait > 0 {
		t := time.NewTimer(wait)
		select {
		case <-t.C:
		case <-qctx.Done():
			t.Stop()
			<-g.sem
			<-globalSem
			return nil, queueErr(ctx)
		}
	}

	g.mu.Lock()
	g.lastStart = time.Now()
	g.mu.Unlock()

	var freed sync.Once
	return func() {
		freed.Do(func() {
			<-g.sem
			<-globalSem
		})
	}, nil
}

// queueErr distinguishes "the caller went away" from "we waited too long".
func queueErr(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return ErrThrottleTimeout
}

func gateFor(host string) *hostGate {
	gatesMu.Lock()
	defer gatesMu.Unlock()

	g, ok := gates[host]
	if !ok {
		g = &hostGate{sem: make(chan struct{}, 1)}
		gates[host] = g
	}
	return g
}

// throttleKey is the first MX host of the address' domain, so that two domains
// behind the same mail provider share one throttle slot. Falls back to the
// domain itself when the lookup fails - the library will run into the same
// problem and report it properly.
func throttleKey(ctx context.Context, email string) string {
	domain := domainOf(email)
	if domain == "" {
		return "unknown"
	}

	if v, ok := mxCache.Load(domain); ok {
		if e, ok := v.(mxEntry); ok && time.Now().Before(e.expires) {
			return e.host
		}
	}

	host := domain
	lctx, cancel := context.WithTimeout(ctx, mxLookupTimeout)
	defer cancel()

	if mxs, err := net.DefaultResolver.LookupMX(lctx, domain); err == nil && len(mxs) > 0 {
		// LookupMX returns records sorted by preference.
		if h := strings.ToLower(strings.TrimSuffix(mxs[0].Host, ".")); h != "" {
			host = h
		}
	}

	mxCache.Store(domain, mxEntry{host: host, expires: time.Now().Add(mxCacheTTL)})
	return host
}

// domainOf returns the lowercased domain part of an address, or "".
func domainOf(email string) string {
	at := strings.LastIndex(email, "@")
	if at < 0 || at == len(email)-1 {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(email[at+1:]))
}

// Domain is the exported form of domainOf, used for PII-free logging.
func Domain(email string) string { return domainOf(email) }
