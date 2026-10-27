# LAN share

A LAN share serves the browser client of OpenBot to the other devices on this network. A phone, a
tablet or another computer opens `https://<this computer>:3100/app` and drives the agents of the
desktop host that runs beside it. Nothing reaches `api.openbot.run` or `signal.openbot.run`: the
account service, the tickets, Signal and the WebRTC path are all this computer's own, and chats and
files stay inside the network.

This is a development share, not a supported deployment. It runs the development stack, so it keeps
the development sign-in (the account service answers with the code instead of sending it) and the
`OpenBot Dev` profile of the desktop app.

## Start it

```sh
bun install --frozen-lockfile   # Bun 1.4.2 exactly: the scripts refuse another version
brew install mkcert
sudo mkcert -install            # the certificate of the share chains to this CA
bun run lan:share --with-app
```

The launcher prints the URL of the share. `--with-app` also starts the desktop host in the
`OpenBot Dev` profile; without it, start the app yourself with the two origins it prints.

The certificate covers the private IPv4 address of this computer and its mDNS name. `--lan-host`
advertises another name, such as `openbot.lan`, when that name resolves on the network.

## Open it on another device

1. Copy `$(mkcert -CAROOT)/rootCA.pem` to the device and install it as a trusted root.
   - iOS and iPadOS: install the profile, then enable it in Settings › General › About › Certificate
     Trust Settings.
   - Android: Settings › Security › Encryption & credentials › Install a certificate › CA certificate.
   - macOS and Windows: add it to the system trust store.
2. Open the printed URL and sign in with any email address. The page shows the code instead of
   sending it.

Without that CA the browser refuses the certificate, and the page has no secure context: WebRTC and
the Web Lock it needs do not run.

## What it runs

| Part | Where |
| --- | --- |
| Browser client and account service | `apps/auth-api`, Vite dev on `0.0.0.0:3100` over HTTPS |
| Signal (WebRTC signalling) | `remote/api` on `0.0.0.0:3101` over TLS, health on `127.0.0.1:3102` |
| Desktop host | `electron-vite dev`, profile `OpenBot Dev` |

Signal calls the account service and receives its revocation webhooks on loopback; only the two
browser origins are shared. The host is set to the `private` network route, so peers connect on host
candidates inside the network: a share advertises no TURN server.

The certificate and the Signal secrets live in `.lan-share/`, which git ignores. Delete that
directory to make a new certificate and new secrets; every device then signs in again.

## Limitations

- The host must be published for a peer to reach it. `--with-app` writes the private route and turns
  on `enabledOnLaunch` of the development profile for that reason.
- The share is the development stack: no auto-update, no hosted servers, and the app profile is the
  development one. Use the release build and a real account for ordinary use.
- OpenBot is licensed under PolyForm Noncommercial 1.0.0. A share is for your own network.
