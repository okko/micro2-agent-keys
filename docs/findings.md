# Input integration constraints

The supported contract is documented in the
[Work Louder WebSocket guide](https://docs.worklouder.cc/websocket/user-guide.md).
Earlier low-level protocol observations are no longer part of this integration.

- Input must be open and must finish loading a supported device before it appears.
- Runtime device IDs change; reconnects and device-list notifications rediscover them.
- Existing Smart Actions cannot be enumerated through the API. The user chooses an activated
  key count during installation, saved in the local configuration. Only the first N slots
  (maximum 20) are enabled; missing mappings within that count are diagnosed on lighting writes.
- Identifiers are case-sensitive. Slots follow identifiers, not physical key positions.
- The API acknowledges lighting writes and reports invalid or unavailable targets.
- The device write budget is shared with other apps; client pacing alone cannot prevent
  rate-limit responses.
- Device/profile/layer changes invalidate cached lighting. Explicit slot reset also retries
  missing mappings after edits in Input.

Automated tests cover authorization, revocation, key filtering, real InputKit WebSocket
requests, changed device IDs, lighting coalescing, missing keys and rate-limit retries.
Physical lighting and Input's approval UI still require the
[manual acceptance check](development.md#manual-acceptance-check).
