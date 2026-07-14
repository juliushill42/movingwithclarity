FROM rust:1.85-slim AS build
WORKDIR /src
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/ledger-service /ledger-service
EXPOSE 4003
CMD ["/ledger-service"]
