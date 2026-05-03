# syntax=docker/dockerfile:1
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod main.go bookmarks.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/start-page .

FROM alpine:3.21
RUN apk add --no-cache ca-certificates
COPY --from=build /out/start-page /usr/local/bin/start-page
EXPOSE 7777

ENV BRAVE_STATS_HOST=0.0.0.0
ENV BRAVE_STATS_PORT=7777
ENV BRAVE_STATS_HTTP_PATH=/api/brave-stats.json
ENV BOOKMARKS_HTTP_PATH=/api/bookmarks.json
ENV BRAVE_PREFERENCES=/prefs/Preferences

ENTRYPOINT ["/usr/local/bin/start-page"]
