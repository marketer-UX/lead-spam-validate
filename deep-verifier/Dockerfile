# syntax=docker/dockerfile:1

FROM golang:1.23-alpine AS build
WORKDIR /src

# go.sum is NOT checked in: the module was pinned by hand, so `go mod tidy` resolves the graph and writes go.sum
# here, at build time. That means the whole source has to be copied before the
# module step - tidy scans the imports. Once go.sum exists in the repo, swap
# these three lines back to the cache-friendly
#   COPY go.mod go.sum ./ && RUN go mod download && COPY . .
COPY . .
RUN go mod tidy && go mod download

ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/server ./cmd/server

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /out/server /server
EXPOSE 8080
# Boot pulls the disposable-domain list (5 s timeout per verifier) and probes
# port 25, hence the generous start period.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8080}/health" || exit 1
ENTRYPOINT ["/server"]
