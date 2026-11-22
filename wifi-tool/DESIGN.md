# CHEATLAB Wi-Fi Studio

## Product brief
A standalone Windows utility paired with a small CHEATLAB web page. It measures internet speed, inventories nearby Wi-Fi access points and channel occupancy, surfaces supported reversible Wi-Fi adapter properties, and shows a before/after preview before changes are applied.

## Visual direction
Use the CHEATLAB monochrome technical workspace: near-black background, charcoal surfaces, off-white text, thin separators, compact type, modest corners, and restrained motion. Keep the interface readable at 900×680 and above. No decorative gradients, neon accents, inflated cards, or ornamental dashboards.

## Main flows
1. Speed test: latency, download, and upload against Cloudflare's public measurement endpoints; state the approximate data usage.
2. Channel scan: use Windows WLAN diagnostics to enumerate visible BSSIDs, signal values, radio channels and band classification; calculate a simple channel occupancy estimate.
3. Adapter settings: only display supported driver properties that match the explicit allowlist (preferred band, roaming aggressiveness, transmit power), select a valid driver-supplied value, preview old → new, request explicit confirmation, save a local backup before applying, and provide a reverse-order restore action.

## Safety and limits
- Do not scan other hosts or devices; only inspect Wi-Fi beacons visible to Windows.
- Do not read Wi-Fi passwords or export saved network profiles.
- Do not modify router configuration or attempt router login. Router channel changes are vendor-specific; this app only recommends a less occupied channel and can open the local default-gateway page.
- Do not run arbitrary commands or accept arbitrary PowerShell snippets from the user.
- Validate every setting name and target value again in elevated PowerShell against the adapter's current driver metadata.
- Save original values under the current Windows user's LocalAppData before applying any changes. Restore in reverse order.
- Never restart the Wi-Fi adapter automatically; a user may lose connectivity. Explain that a reconnect may be needed.
