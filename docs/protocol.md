# Supported lighting profile

One legacy profile is implemented: device type 53 (`0x35`), RGB plus warm/cool-white channels, using raw commands on TCP 5577. There is no UDP discovery, pairing, cloud transport, or versioned envelope in this driver.

## Frames

Numbers are hexadecimal bytes. The checksum is the sum of all preceding bytes modulo 256.

| Action | Bytes |
| --- | --- |
| State query | `81 8A 8B 96` |
| Power on | `71 23 0F A3` |
| Power off | `71 24 0F A4` |
| RGB | `31 RR GG BB 00 00 F0 0F CC` |
| White | `31 00 00 00 WW CW 0F 0F CC` |

`CC` is the checksum. `RR`, `GG`, `BB`, `WW`, and `CW` are 0–255 channel values. White brightness splits a bounded total level between warm and cool. The UI maps 2700–6500 K linearly onto that ratio; this is an estimate, not a colorimetric measurement.

The parser looks for a valid 14-byte response, allowing fragmented or coalesced TCP reads. It validates the checksum before interpreting the state.

| Byte index | Meaning used by the driver |
| --- | --- |
| 0 | `81` response marker |
| 1 | Device type; registration requires `35` |
| 2 | Power: `23` on, `24` off |
| 3 | Mode; `61` indicates static channel control |
| 6–8 | Red, green, blue |
| 9 | Warm-white channel |
| 10 | State-version field |
| 11 | Cool-white channel |
| 12 | `0F` trailer |
| 13 | Checksum |

Other fields are not used to infer capabilities. The **state-version field is not a module-version identifier** and does not select a protocol wrapper.

## Scope and verification

A matching type response cannot establish universal compatibility across rebranded models. A subsequent state query confirms reported power/channels, not measured physical light output. A socket write alone is not device acknowledgement.

Only explicitly registered private IPv4 addresses and fixed TCP 5577 are used. Registration sends one read-only query before saving. Registered bulbs are queried periodically while a browser is connected. User actions and scheduled timers produce control writes; startup does not replay them.

Packet encoding/parsing, transport/state, and the HTTP API are separate modules so additional profiles can be implemented explicitly.
