# Topology Control Plane Test Scenarios

## Scenario 1: phone joins through desktop, offline phone learns it later

Devices:
- A: Android phone already paired with B
- B: Windows desktop
- C: Android phone newly paired with B

Steps:
1. Start B desktop.
2. Keep A offline or force stop the Android app.
3. Pair C with B by scanning B's QR code.
4. Confirm B topology shows A, B, C.
5. Start A and trigger a connect/sync action.
6. Confirm A receives `topology_delta` and stores C in the device list.
7. Send one SMS/TOTP relay from A and confirm C is a candidate target when enabled.

Expected:
- C is advertised through `topology_delta`.
- A imports C after reconnecting even though A was offline when C joined.
- LAN discovery-only nodes are visible but not routable until they have pairing material.

## Scenario 2: desktop peer joins, phones learn desktop node

Devices:
- A: Android phone paired with B
- C: Android phone paired with B
- B: Windows desktop
- D: Windows desktop newly paired with B

Steps:
1. Pair D with B by scanning D's QR or LAN pairing flow.
2. Confirm B and D establish a desktop peer WebSocket session.
3. Confirm B sends `topology_delta` to online phones and D.
4. Reconnect A if it was offline.
5. Confirm A and C can see D as a desktop node.

Expected:
- D is represented as `WINDOWS_DESKTOP`.
- B-D links are `desktop_pair` links with `routable=true`.
- A/C route tables can include D after they receive the control-plane update.

## Scenario 3: gossip loop protection

Steps:
1. Create topology A -> B -> C -> B.
2. Watch logs for repeated `topology_delta`.
3. Verify each node accepts only increasing `seq` values per `sourceDeviceId`.

Expected:
- Duplicate or stale deltas are ignored.
- `relayTtl`/`ttl` decreases at each relay hop.
- No infinite rebroadcast loop appears.

## Scenario 4: display edges vs routing edges

Steps:
1. Discover an unpaired LAN node.
2. Open topology view.
3. Pair the same node.
4. Open topology view again.

Expected:
- Before pairing: node and `lan_discovery` edge are displayed but excluded from SPF.
- After pairing: trusted `routing_adjacency`, `verify_push`, `relay_route`, or `desktop_pair` edges become routable.
