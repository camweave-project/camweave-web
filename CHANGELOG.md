# Changelog

## 1.0.0 — 2026-09-27

- Self-hosted responsive web viewer with up to four simultaneous live cameras and pagination for additional saved cameras.
- Single-camera view with unified quality, frame-rate and automatic/manual ISO controls.
- Shared-owner password login, expiring sessions, same-origin controls, exact camera-host allowlist and no camera redirects.
- Node.js and Docker Compose deployment, private-network/VPS connection guide, MIT license.
- Validated with HTTP integration tests; browser checks at desktop and 390px width; real CamWeave BrowserServer protocol ISO readback; Docker build/start/login smoke test. Physical VPN/VPS network configurations depend on the operator's deployment and were not provisioned by these tests.
