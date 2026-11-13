# syntax=docker/dockerfile:1

# ---------- build ----------
FROM rust:1-slim-bookworm AS build
WORKDIR /src

# Build dependencies first so they are cached between source changes.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
 && cargo build --release --locked \
 && rm -rf src

COPY src ./src
COPY templates ./templates
COPY static ./static
RUN touch src/main.rs && cargo build --release --locked

# ---------- runtime ----------
# Distroless: no shell, no package manager, glibc only. Runs as a non-root user.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/vault-share /usr/local/bin/vault-share

ENV DATA_DIR=/data \
    BIND_ADDR=0.0.0.0:8080 \
    RUST_LOG=info

# 568 = the "apps" user on TrueNAS SCALE. Override with `user:` in compose if needed.
USER 568:568
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/vault-share", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/vault-share"]
