// Command server is the stage-2 SMTP deep verifier of lead-validate.
//
// It wraps github.com/AfterShip/email-verifier (MIT) behind two endpoints:
//
//	GET|POST /check?email=&mode=fast|deep   X-Api-Key required
//	GET      /health                        unauthenticated
//
// /check never answers 5xx: any internal failure comes back as HTTP 200 with
// verdict "unknown", so a broken stage 2 can never block a lead form.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/marketer-UX/lead-spam-validate/deep-verifier/internal/handler"
	"github.com/marketer-UX/lead-spam-validate/deep-verifier/internal/verify"
)

// version is overridden at build time: -ldflags "-X main.version=$(git rev-parse --short HEAD)".
var version = "dev"

const shutdownGrace = 30 * time.Second

func main() {
	var (
		port      = env("PORT", "8080")
		apiKey    = os.Getenv("API_KEY")
		fromEmail = env("FROM_EMAIL", "noreply@example.com")
		helloName = env("HELLO_NAME", "verify.example.com")
		allowNoAuth = os.Getenv("ALLOW_NO_AUTH") == "1"
	)

	log := newLogger()

	if apiKey == "" {
		if !allowNoAuth {
			log.Error("refusing to boot: API_KEY is empty - /check would be reachable by anyone. Set API_KEY, or ALLOW_NO_AUTH=1 for local development only.")
			os.Exit(1)
		}
		log.Warn("API_KEY is empty and ALLOW_NO_AUTH=1 - /check is UNAUTHENTICATED. Local development only.")
	}

	cfg := handler.Config{
		APIKey:    apiKey,
		FromEmail: fromEmail,
		HelloName: helloName,
		Version:   version,
		Started:   time.Now(),
		Log:       log,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// EnableAutoUpdateDisposable pulls the disposable-domain list
	// synchronously (5 s timeout, once per verifier instance), so Init can
	// take a few seconds. The port-25 probe runs alongside it instead of
	// after it; both are done before we start listening, so /health is
	// accurate from the first request and /check never sees a nil verifier.
	probed := make(chan struct{})
	go func() {
		defer close(probed)
		// Probes once now, then every 10 minutes - never on the request path.
		handler.StartSMTP25Probe(ctx, log)
	}()

	verify.Init(fromEmail, helloName)
	<-probed

	mux := http.NewServeMux()
	mux.HandleFunc("/check", handler.Check(cfg))
	mux.HandleFunc("/health", handler.Health(cfg))
	mux.HandleFunc("/", handler.NotFound)

	srv := &http.Server{
		Addr:              net.JoinHostPort("0.0.0.0", port),
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		// Above handler.RequestTimeout, so the fail-open body still gets out.
		WriteTimeout: 35 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	log.Info("deep-verifier listening",
		"event", "boot",
		"addr", srv.Addr,
		"version", version,
		"from_email", fromEmail,
		"hello_name", helloName,
		"auth", apiKey != "",
		"allow_no_auth", allowNoAuth,
	)

	select {
	case err := <-errCh:
		log.Error("listen failed", "event", "boot_failed", "error", err.Error())
		os.Exit(1)
	case <-ctx.Done():
	}

	stop() // a second signal from here on kills the process outright
	log.Info("shutdown signal received, draining", "event", "shutdown", "grace_s", int(shutdownGrace.Seconds()))

	shCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()

	if err := srv.Shutdown(shCtx); err != nil {
		log.Error("graceful shutdown failed", "event", "shutdown_failed", "error", err.Error())
		os.Exit(1)
	}
	log.Info("stopped", "event", "stopped")
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

// newLogger writes JSON lines when LOG_JSON=1 (log shippers such as Loki), text otherwise.
func newLogger() *slog.Logger {
	opts := &slog.HandlerOptions{Level: slog.LevelInfo}
	if os.Getenv("LOG_JSON") == "1" {
		return slog.New(slog.NewJSONHandler(os.Stdout, opts))
	}
	return slog.New(slog.NewTextHandler(os.Stdout, opts))
}
