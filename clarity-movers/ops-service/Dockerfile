FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
RUN go build -o /ops-service .

FROM alpine:3.20
COPY --from=build /ops-service /ops-service
EXPOSE 4002
CMD ["/ops-service"]
