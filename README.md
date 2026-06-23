ephemera — Privater Einmal-Chat
Ephemerer, Ende-zu-Ende-verschlüsselter Einmal-Chat.  
Kein Login. Keine Datenbank. Keine Speicherung.
---
Projektstruktur
```
/
  package.json    – Dependencies (express, ws)
  server.js       – Node.js-Server (HTTP + WebSocket)
  /public
    index.html    – Einzige HTML-Datei (SPA-Shell)
    client.js     – Client-Logik + Krypto (Web Crypto API)
    style.css     – Styling
  README.md
```
---
Installation & lokaler Start
```bash
# 1. Abhängigkeiten installieren
npm install

# 2. Server starten
npm start
# → läuft auf http://localhost:3000

# Oder mit Auto-Reload (Node 18+):
npm run dev
```
Dann im Browser `http://localhost:3000` öffnen.
---
Deployment auf einer Subdomain
Variante A: Direkt mit Node.js + Reverse Proxy (empfohlen)
nginx-Konfiguration für `chat.example.de`:
```nginx
server {
    listen 443 ssl http2;
    server_name chat.example.de;

    ssl_certificate     /etc/letsencrypt/live/chat.example.de/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.de/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";  # WebSocket-Support!
        proxy_set_header   Host       $host;
        proxy_set_header   X-Real-IP  $remote_addr;
    }
}
```
> **Wichtig:** `Upgrade`/`Connection`-Header sind für WebSockets zwingend.
Prozess dauerhaft laufen lassen (pm2):
```bash
npm install -g pm2
pm2 start server.js --name ephemera
pm2 save
pm2 startup
```
Variante B: Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```
```bash
docker build -t ephemera .
docker run -d -p 3000:3000 --restart unless-stopped ephemera
```
Variante C: Railway / Render / Fly.io
Diese Plattformen können Node.js-Apps direkt deployen. WebSocket-Support
ist bei allen dreien vorhanden. Einfach Repository verbinden und deployen.
---
Sicherheitsmodell
Was der Server macht:
Erzeugt eine zufällige Raum-ID (`crypto.randomBytes(16)`)
Nimmt WebSocket-Verbindungen entgegen
Leitet verschlüsselte Blobs blind weiter — ohne sie zu lesen
Löscht Räume nach Ende oder Inaktivität aus dem RAM
Was der Server nicht macht:
Nachrichten lesen (er sieht nur verschlüsselte base64-Blobs)
Nachrichten speichern
Schlüssel kennen
URLs oder Inhalte loggen
Verschlüsselung:
Die Nachrichten werden im Browser mit AES-GCM-256 verschlüsselt,
bevor sie den Browser verlassen. Der Ablauf:
Person A klickt „Chat erstellen"
Der Browser erzeugt einen zufälligen AES-256-Schlüssel via `crypto.subtle.generateKey`
Der Schlüssel wird nie an den Server gesendet
Der Schlüssel wird als base64url-String im URL-Fragment (`#...`) gespeichert
Person A teilt den kompletten Link (inkl. `#key`) mit Person B
Person B öffnet den Link — der Browser importiert den Schlüssel aus dem Fragment
Das Fragment wird sofort aus der URL entfernt (`history.replaceState`)
Alle Nachrichten werden mit zufälligem IV verschlüsselt und als base64 über den Server weitergeleitet
Der Empfänger entschlüsselt lokal
Warum steht der Schlüssel im URL-Fragment (`#`)?
Das HTTP-Protokoll und Browser übertragen das Fragment nie an den Server.
Es steht nur im Browser-Speicher, nicht im HTTP-Request. Das bedeutet:
Kein Server-Log kann den Schlüssel enthalten
Kein Proxy/CDN sieht den Schlüssel
Nur wer den vollständigen Link kennt, kann die Nachrichten lesen
Der Server kann die Nachrichten nicht entschlüsseln.
Der Server kennt weder den Schlüssel noch die Klartexte. Er sieht
ausschließlich verschlüsselte base64-Strings, die er blind weiterleitet.
Selbst ein kompromittierter Server könnte keine Nachrichten lesen,
solange der Schlüssel nicht anderweitig bekannt wird.
---
Grenzen der Anonymität
Was dieses System schützt:
Nachrichteninhalte (verschlüsselt, nie im Server-Log)
Chatverläufe (werden nicht gespeichert)
Schlüssel (verbleiben im Browser)
Was dieses System nicht schützt:
Metadatum	Erläuterung
IP-Adressen	Der Server sieht die IP beider Verbindungen (ggf. hinter Proxy). Für echte Anonymität Tor oder VPN verwenden.
Verbindungszeitpunkte	Wann sich wer verbunden hat, ist aus Server-Logs rekonstruierbar (falls aktiviert). Im Code sind Logs deaktiviert, aber ein Hosting-Provider könnte trotzdem Zugriffszeiten speichern.
Raum-ID	Die Raum-ID ist zufällig, aber für alle sichtbar, die Zugriff auf Server-Logs haben.
URL-Fragment im Verlauf	Das Fragment kann in Browser-History oder Autofill auftauchen, falls der Nutzer es nicht löscht.
Endgerät-Kompromittierung	Ist das Endgerät befallen (Keylogger, Screenrecorder), ist die Verschlüsselung nutzlos.
Man-in-the-Middle ohne HTTPS	Ohne TLS könnte ein Angreifer im Netzwerk den WebSocket belauschen und den Schlüssel aus der URL abgreifen. HTTPS ist Pflicht für produktiven Einsatz.
Fazit:
Ephemera schützt vor einem neugierigen Server-Betreiber und vor dauerhafter
Datenspeicherung. Es ist kein Anonymisierungswerkzeug und ersetzt kein
dediziertes Privacy-Tool wie Signal.
---
Automatisches Löschen
Räume werden sofort gelöscht, wenn:
ein Teilnehmer „Chat beenden" klickt
alle Verbindungen geschlossen werden
Räume werden nach 30 Minuten Inaktivität automatisch gelöscht
Nach dem Löschen ist der Link ungültig (WebSocket-Close-Code `4001`)
---
Technische Details
Eigenschaft	Wert
Verschlüsselung	AES-GCM-256
IV-Länge	12 Byte (zufällig pro Nachricht)
Schlüssellänge	256 Bit
Max. Teilnehmer	2 pro Raum
Max. Nachrichtenlänge	4.000 Zeichen (Klartext)
Inaktivitäts-Timeout	30 Minuten
Datenspeicherung	keine (nur RAM, flüchtig)
Dependencies	express, ws (2 Pakete)
Node.js	≥ 18
