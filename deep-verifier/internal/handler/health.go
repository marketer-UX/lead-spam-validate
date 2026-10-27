package handler

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"
)

const (
	// SMTP25Target is a mail server that is always up and always speaks on
	// port 25. If we cannot reach it, this host cannot do SMTP verification
	// at all (many PaaS and cloud providers block outbound 25; a VPS with the
	// port unlocked reaches it).
	SMTP25Target = "alt1.gmail-smtp-in.l.google.com:25"
	// SMTP25Timeout is the dial timeout of the probe.
	SMTP25Timeout = 3 * time.Second
	// SMTP25Interval is how often the probe is repeated.
	SMTP25Interval = 10 * time.Minute
)

var (
	smtp25Mu        sync.RWMutex
	smtp25OK        bool
	smtp25CheckedAt time.Time
)

type healthResp struct {
	OK              bool   `json:"ok"`
	Version         string `json:"version"`
	UptimeS         int64  `json:"uptime_s"`
	SMTP25          bool   `json:"smtp25"`
	SMTP25CheckedAt string `json:"smtp25_checked_at"`
	HelloName       string `json:"hello_name"`
	FromEmail       string `json:"from_email"`
}

// StartSMTP25Probe runs the port-25 probe once, synchronously, and then keeps
// refreshing it every SMTP25Interval until ctx is done. The probe never runs on
// the request path - /health only reads the cached result.
func StartSMTP25Probe(ctx context.Context, log *slog.Logger) {
	probeSMTP25(log)

	go func() {
		t := time.NewTicker(SMTP25Interval)
		defer t.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				probeSMTP25(log)
			}
		}
	}()
}

func probeSMTP25(log *slog.Logger) {
	conn, err := net.DialTimeout("tcp", SMTP25Target, SMTP25Timeout)
	if conn != nil {
		_ = conn.Close()
	}

	smtp25Mu.Lock()
	smtp25OK = err == nil
	smtp25CheckedAt = time.Now().UTC()
	smtp25Mu.Unlock()

	if log == nil {
		return
	}
	if err != nil {
		log.Warn("smtp port 25 probe failed - deep checks will report unknown",
			"event", "smtp25_probe", "target", SMTP25Target, "smtp25", false, "error", err.Error())
		return
	}
	log.Info("smtp port 25 reachable",
		"event", "smtp25_probe", "target", SMTP25Target, "smtp25", true)
}

func smtp25Snapshot() (bool, time.Time) {
	smtp25Mu.RLock()
	defer smtp25Mu.RUnlock()
	return smtp25OK, smtp25CheckedAt
}

// Health serves GET /health, unauthenticated, so platform health checks and Caddy can probe it.
func Health(cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		ok, checkedAt := smtp25Snapshot()

		stamp := ""
		if !checkedAt.IsZero() {
			stamp = checkedAt.Format(time.RFC3339)
		}

		writeJSON(w, http.StatusOK, healthResp{
			OK:              true,
			Version:         cfg.Version,
			UptimeS:         int64(time.Since(cfg.Started).Seconds()),
			SMTP25:          ok,
			SMTP25CheckedAt: stamp,
			HelloName:       cfg.HelloName,
			FromEmail:       cfg.FromEmail,
		})
	}
}
