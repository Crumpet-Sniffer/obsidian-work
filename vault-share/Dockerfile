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

# ---------- ingest worker ----------
# The Node.js process that files uploaded sources in the background (src/worker.rs starts it). worker.mjs is built
# and committed (viewer/build-worker.mjs); only its native dependency, ONNX Runtime for OCR, is installed here,
# without the optional GPU downloads, and without the macOS and Windows binaries it ships with.
FROM node:22-bookworm-slim AS worker
WORKDIR /worker
COPY worker/package.json worker/package-lock.json ./
RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev --no-audit --no-fund \
 && rm -rf node_modules/onnxruntime-node/bin/napi-v*/darwin node_modules/onnxruntime-node/bin/napi-v*/win32
COPY worker/worker.mjs ./
# The app runs as an unprivileged user, and COPY keeps the checkout's modes (root-only when it was cloned with
# sudo): make the worker readable by everyone.
RUN chmod -R a+rX /worker

# ---------- OCR files ----------
# Read by the ingest worker. PaddleOCR PP-OCRv6 small, PaddlePaddle's own ONNX exports (Apache-2.0), pinned and
# checked. Same files: viewer/fetch-ocr.mjs.
FROM scratch AS ocr
ADD --chmod=644 --checksum=sha256:d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e \
    https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/28fe5895c24fd108c19eb3e8479f4ab385fbfc62/inference.onnx \
    /ocr/PP-OCRv6_small_det.onnx
ADD --chmod=644 --checksum=sha256:5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634 \
    https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/b8f84f0b80c529de40b4fbb3544b84fa7233a513/inference.onnx \
    /ocr/PP-OCRv6_small_rec.onnx
# The recognition model's character list, taken unchanged from its inference.yml.
COPY --chmod=644 ocr/ppocrv6_dict.txt /ocr/ppocrv6_dict.txt

# ---------- runtime ----------
# Distroless: no shell, no package manager; glibc, libstdc++ and Node.js (for the ingest worker) only.
# Runs as a non-root user.
FROM gcr.io/distroless/nodejs22-debian12:nonroot
COPY --from=build /src/target/release/vault-share /usr/local/bin/vault-share
COPY --from=ocr /ocr /usr/local/share/vault-share/ocr
COPY --from=worker /worker /usr/local/share/vault-share/worker

ENV DATA_DIR=/data \
    OCR_DIR=/usr/local/share/vault-share/ocr \
    NODE_BIN=/nodejs/bin/node \
    INGEST_WORKER=/usr/local/share/vault-share/worker/worker.mjs \
    BIND_ADDR=0.0.0.0:8080 \
    RUST_LOG=info

# 568 = the "apps" user on TrueNAS SCALE. Override with `user:` in compose if needed.
USER 568:568
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/vault-share", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/vault-share"]
