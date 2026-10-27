// Package handler holds the HTTP surface of the deep verifier: /check and
// /health. No framework, just net/http.
package handler

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	ev "github.com/AfterShip/email-verifier"

	"github.com/marketer-UX/lead-spam-validate/deep-verifier/internal/verify"
)

const (
	// RequestTimeout caps a single /check request end to end.
	RequestTimeout = 25 * time.Second
	// ProviderName goes into every response so the caller can tell the
	// stage-2 providers apart.
	ProviderName = "aftership"

	maxBodyBytes = 8 << 10
	maxErrChars  = 200
)

// Config is the shared, read-only state both handlers need.
type Config struct {
	APIKey    string
	FromEmail string
	HelloName string
	Version   string
	Started   time.Time
	Log       *slog.Logger
}

type checkOK struct {
	Result    *ev.Result `json:"result"`
	Provider  string     `json:"provider"`
	Mode      string     `json:"mode"`
	LatencyMS int64      `json:"latency_ms"`
}

type checkFailOpen struct {
	Verdict   string   `json:"verdict"`
	Flags     []string `json:"flags"`
	Provider  string   `json:"provider"`
	Mode      string   `json:"mode"`
	LatencyMS int64    `json:"latency_ms"`
	Error     string   `json:"error"`
}

type errorResp struct {
	Error string `json:"error"`
}

type checkRequest struct {
	Email string `json:"email"`
	Mode  string `json:"mode"`
}

// Check serves GET /check?email=&mode=fast|deep and POST /check with a JSON
// body {"email":"...","mode":"..."}.
//
// It never answers 5xx. Every failure of the verifier - DNS, SMTP refused,
// timeout, throttle - comes back as HTTP 200 with verdict "unknown", because a
// broken stage 2 must never block a lead form.
func Check(cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, errorResp{Error: "method_not_allowed"})
			return
		}

		if !authorized(cfg.APIKey, r.Header.Get("X-Api-Key")) {
			writeJSON(w, http.StatusUnauthorized, errorResp{Error: "unauthorized"})
			return
		}

		email, mode := readParams(r)
		if email == "" {
			writeJSON(w, http.StatusBadRequest, errorResp{Error: "missing email"})
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), RequestTimeout)
		defer cancel()

		start := time.Now()

		var (
			res *ev.Result
			err error
		)
		if mode == "deep" {
			res, err = verify.DeepContext(ctx, email)
		} else {
			res, err = verify.FastContext(ctx, email)
		}

		latency := time.Since(start).Milliseconds()

		if err != nil || res == nil {
			if err == nil {
				err = errors.New("empty result")
			}
			msg := shortError(err, email)
			logCheck(cfg, email, mode, latency, "unknown", msg)

			// Fail-open. Never 5xx towards the intake.
			writeJSON(w, http.StatusOK, checkFailOpen{
				Verdict:   "unknown",
				Flags:     []string{},
				Provider:  ProviderName,
				Mode:      mode,
				LatencyMS: latency,
				Error:     msg,
			})
			return
		}

		logCheck(cfg, email, mode, latency, res.Reachable, "")

		writeJSON(w, http.StatusOK, checkOK{
			Result:    res,
			Provider:  ProviderName,
			Mode:      mode,
			LatencyMS: latency,
		})
	}
}

// authorized compares in constant time. An empty configured key means auth is
// switched off - main refuses to boot in that state unless ALLOW_NO_AUTH=1.
func authorized(want, got string) bool {
	if want == "" {
		return true
	}
	return subtle.ConstantTimeCompare([]byte(want), []byte(got)) == 1
}

// readParams takes email/mode from the query string, and for POST also from a
// JSON body. Query wins when both are set.
func readParams(r *http.Request) (email, mode string) {
	email = strings.TrimSpace(r.URL.Query().Get("email"))
	mode = r.URL.Query().Get("mode")

	if r.Method == http.MethodPost && r.Body != nil {
		var body checkRequest
		raw, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
		if err == nil && len(raw) > 0 {
			if json.Unmarshal(raw, &body) == nil {
				if email == "" {
					email = strings.TrimSpace(body.Email)
				}
				if mode == "" {
					mode = body.Mode
				}
			}
		}
	}

	return email, normalizeMode(mode)
}

func normalizeMode(mode string) string {
	if strings.EqualFold(strings.TrimSpace(mode), "deep") {
		return "deep"
	}
	return "fast"
}

// shortError keeps the payload small and strips the address out of library and
// SMTP messages, which happily quote it back at us.
func shortError(err error, email string) string {
	switch {
	case errors.Is(err, verify.ErrThrottleTimeout):
		return "throttle_timeout"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "canceled"
	}

	msg := strings.TrimSpace(err.Error())
	msg = strings.NewReplacer("\r", " ", "\n", " ").Replace(msg)

	if email != "" {
		msg = strings.ReplaceAll(msg, email, "<email>")
		if local, _, ok := strings.Cut(email, "@"); ok && local != "" {
			msg = strings.ReplaceAll(msg, local, "<local>")
		}
	}

	if len(msg) > maxErrChars {
		msg = msg[:maxErrChars] + "..."
	}
	if msg == "" {
		msg = "unknown error"
	}
	return msg
}

// logCheck logs the domain and a short hash - never the address itself.
func logCheck(cfg Config, email, mode string, latency int64, reachable, errMsg string) {
	if cfg.Log == nil {
		return
	}

	attrs := []any{
		"event", "check",
		"mode", mode,
		"domain", verify.Domain(email),
		"email_sha256", fingerprint(email),
		"latency_ms", latency,
		"reachable", reachable,
	}
	if errMsg != "" {
		attrs = append(attrs, "error", errMsg)
		cfg.Log.Warn("check failed open", attrs...)
		return
	}
	cfg.Log.Info("check", attrs...)
}

// fingerprint is the first 12 hex chars of sha256(lowercased address). Enough
// to correlate log lines, not enough to recover the address.
func fingerprint(email string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return hex.EncodeToString(sum[:])[:12]
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// NotFound is the catch-all so unknown paths answer JSON too.
func NotFound(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusNotFound, errorResp{Error: "not found"})
}
