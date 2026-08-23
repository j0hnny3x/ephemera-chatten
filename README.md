Hier alle Features von ephemera auf einen Blick:

ephemera hat zwei Betriebsarten, die sich auf der Startseite umschalten lassen:
**Chat** fuer ein Gespraech zu zweit, **Einmal-Nachricht** fuer eine einzelne
Nachricht, die sich nach dem Lesen selbst zerstoert.

---

## Einmal-Nachricht

Eine verschluesselte Einweg-Nachricht: schreiben, Link verschicken, einmal lesen,
weg. Kein WebSocket, kein Gegenueber noetig — der Empfaenger kann den Link
oeffnen, wann er will.

**Ablauf**
1. Nachricht eintippen, Frist waehlen, auf *Nachricht erstellen* tippen
2. Link kopieren und ueber WhatsApp, Telegram, Signal oder SMS verschicken
3. Empfaenger oeffnet den Link, liest — die Nachricht zerstoert sich

**Optionen**
- Frist: 2 Std. / 12 Std. / 24 Std. / 2 Tage / 7 Tage / 14 Tage
- *Nach dem Lesen loeschen* (Standard: an) — aus bedeutet: bis zum Fristende lesbar
- Optionales Passwort, SHA-256-gehasht, Klartext bleibt im Browser
- Bis 10.000 Zeichen, Links und Smileys werden automatisch umgewandelt

**Sicherheit**
- AES-GCM-256 im Browser verschluesselt — der Server speichert nur Ciphertext
- Schluessel steht im URL-Fragment `#` und wird nie an den Server uebertragen
- Nach dem Oeffnen verschwindet der Schluessel aus der Browser-Adresszeile
- Zerstoert wird ausschliesslich per POST — Link-Vorschau-Bots von WhatsApp und
  Telegram rufen nur GET auf und koennen die Nachricht daher nicht ausloesen
- Kein Konto, keine IP-Speicherung; Ratenbegrenzung arbeitet mit gehashten,
  nur im RAM gehaltenen Werten
- Eigene Link-Vorschau: geteilte Notiz-Links zeigen nicht „Chat“ an

**Speicherung**
Damit die 14-Tage-Frist einen Serverneustart uebersteht, wird der Ciphertext nach
`data/notes.json` geschrieben (per `EPHEMERA_DATA_DIR` umstellbar, in `.gitignore`,
per Middleware nicht ueber HTTP erreichbar). Ohne den Schluessel aus dem Link ist
die Datei auch mit Vollzugriff nicht lesbar. Abgelaufenes wird minuetlich entfernt.

**Routen**
| Route | Zweck |
|---|---|
| `POST /api/note` | Nachricht anlegen |
| `GET /api/note/:id` | Status abfragen — verbraucht die Nachricht **nicht** |
| `POST /api/note/:id/open` | Oeffnen — hier wird zerstoert |
| `GET /n/:id` | Empfaengerseite |

---

## Chat

🔐 Sicherheit & Verschlüsselung

AES-GCM-256 Ende-zu-Ende-Verschlüsselung — Server sieht nur unlesbaren Ciphertext
Forward Secrecy — alle 10 Nachrichten automatisch neuer Sub-Schlüssel
Schlüssel nur im URL-Fragment # — wird nie an den Server übertragen
Optionales Raumpasswort — SHA-256-gehasht, Server sieht nie den Klartext
Passwort-Stärke-Anzeige beim Erstellen
Link-Vorschau-Schutz — unsichtbares Zeichen verhindert WhatsApp-Bot
🔒 RAUM VERSIEGELT Banner sobald beide Teilnehmer drin sind
Keine Datenbank, kein Login, kein Account, keine Cookies
Keine Nachrichtenlogs auf dem Server
Content-Security-Policy, X-Frame-Options, Referrer-Policy gesetzt


💬 Nachrichten

Textnachrichten mit bis zu 4.000 Zeichen
Bilder senden — automatische Komprimierung auf max. 2MB via Canvas API
Sprachnachrichten — Mikrofon-Button, Wellenform-Visualisierung, max. 2 Min.
Videonachrichten — Kamera aufnehmen, max. 1 Minute, Vorschau vor dem Senden
Dateien senden — PDFs, ZIP, Dokumente bis 10MB, verschlüsselt
Drag & Drop — Dateien einfach ins Fenster ziehen
Nachricht bearbeiten — 30-Sekunden-Fenster nach dem Senden
Nachricht zurückziehen — löscht bei beiden sofort
Selbstlöschende Nachrichten — 10 Sek. / 30 Sek. / 1 Min. / 5 Min.
Emoji-Reaktionen — 👍 ❤️ 😂 😮 😢 🔥
Reply / Antworten — mit Zitat der Original-Nachricht
Vollbild-Ansicht für Bilder und Videos


📡 Verbindung & Stabilität

Max. 2 Teilnehmer pro Raum
Nachrichten-Puffer im RAM — Nachrichten geschrieben bevor Partner da ist werden sofort zugestellt wenn er beitritt
Auto-Reconnect — bis zu 10 Versuche mit exponential backoff
Sofort-Reconnect wenn Tab wieder aktiv wird (visibilitychange)
Keepalive-Ping alle 20 Sekunden — hält Verbindung stabil
30 Minuten Kulanz nach Disconnect — Raum bleibt bestehen
Raum verlängern — bis zu 3× +1 Stunde per Klick
2 Stunden Gesamt-Laufzeit mit sichtbarem Countdown


📊 Status & Anzeigen

⏳ ✓ ✓✓ Nachrichten-Status — ausstehend / gesendet / gelesen
Lese-Uhrzeit — ✓✓ 14:32 wann genau gelesen wurde
Tipp-Indikator — Partner schreibt…
Partner online/offline Banner mit Zeitstempel
Ungelesene Nachrichten im Tab-Titel — (3) ephemera
Ping-Sound bei neuer Nachricht (Web Audio API)
Vibration auf Handy bei neuer Nachricht
// NEUE NACHRICHTEN Trennlinie


🎨 Optik & UX

Matrix-Ästhetik — fallender Code-Regen, Glitch-Effekt, alles in Grün auf Schwarz
Schriftgröße einstellbar — A− / A+ von 11px bis 22px
Link wird beim Erstellen automatisch in Zwischenablage kopiert
QR-Code generieren zum Abscannen
Vollbild-Ansicht für Bilder und Videos
Drag & Drop mit Matrix-grünem Drop-Overlay
Countdown-Timer mit Farbwechsel — grün → orange → rot blinkend


🗑 Datenschutz & Löschung

Raum nach Ende sofort aus RAM gelöscht
Link danach ungültig
Raum nach 30 Min. Inaktivität aller Teilnehmer automatisch gelöscht
Gepufferte Nachrichten werden nach Zustellung sofort aus RAM gelöscht
Fragment #key wird nach Import sofort aus Browser-URL entfernt
Kein localStorage, kein sessionStorage, keine Cookies
