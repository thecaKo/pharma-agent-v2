# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Periodic application-level heartbeat while connected, configurable via `HEARTBEAT_INTERVAL_MS` (default 30s).
- Native WebSocket ping/pong with pong-timeout detection of zombie sockets, configurable via `WS_PING_INTERVAL_MS` / `WS_PONG_TIMEOUT_MS`.
- Warning log when heartbeat send fails (previously silent).
