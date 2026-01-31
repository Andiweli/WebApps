# 🏠 WebApps für Zuhause (Raspberry Pi)  
**Self-Hosting mit Node.js, Excel-Export & Tailscale**

Kleine, praktische WebApps für den privaten Alltag: lokal im Heimnetz betreibbar, datensparsam und schnell verfügbar.
Die Anwendungen laufen auf Wunsch auf einem Raspberry Pi und helfen dabei, Notizen/Zettelwirtschaft durch strukturierte Eingaben,
Historien und übersichtliche Auswertungen zu ersetzen. Viele Daten können als Excel-Datei exportiert und weiterverarbeitet werden.

Mit Tailscale kannst du die WebApps außerdem sicher von unterwegs am Smartphone nutzen – auf Wunsch „wie eine App“
(per Homescreen-Verknüpfung), ohne App-Store.

---

## 📦 WebApps in diesem Repository

### ☀️ PV Neigungsrechner
- Optimiert PV-Ausrichtung und Neigungswinkel bei Balkonkraftwerken mit verstellbarer Aufständerung für bessere Erträge
- Schnelle Szenario-Vergleiche (z.B. Winkel-Schritte, Ausrichtung, Optimierungsziel)
- Ideal als lokales PV-Dashboard im Heimnetz

### ⚡ NetzNÖ Zählerstand
- Komfortables Erfassen von Zählerständen (z.B. Strom/Gas)
- Historie & Einträge-Listen für Überblick und Kontrolle sowie Verbrauch seit letzter Jahresablesung
- 📤 Export (Excel) zur Auswertung/Archivierung

---

## ✨ Highlights
- 🛠️ **Self-Hosting**: lokal im Heimnetz oder auf Raspberry Pi betreibbar
- 🔒 **Datenschutzfreundlich**: Daten bleiben bei dir (keine Cloud-Pflicht)
- 🗒️ **Alltagstauglich**: ersetzt Notepad/Notizblock durch strukturierte Eingaben
- 📊 **Excel-Export**: Daten in Excel weiterverarbeiten (Auswertung, Statistik, Archiv)
- 📱 **Mobil nutzbar**: sicherer Zugriff von unterwegs mit Tailscale
- 🧰 **Tech-Stack**: Node.js-basierte WebApps (plus Tools je nach App)

---

## 🧱 Tech Stack (Kurzüberblick)
- 🟩 **Node.js** (Backend / API / Server)
- 🌐 **HTML / CSS / JavaScript** (Frontend)
- 🧩 Optional je nach App: lokale Datenhaltung, Export-Generatoren, Helper-Skripte

> Hinweis: Für jede App muss in der jeweiligen `server.js` am Ende der Platzhalter für Port und IP des eigenen Servers angepassts werden.

---

## 🖼️ Screenshots
- `docs/screenshots/pv-neigungsrechner.png` – PV Neigungsrechner (Startansicht)
- `docs/screenshots/netznoe-zaehlerstand.png` – NetzNÖ Zählerstand (Einträge & Export)

---

## 🚀 Installation (lokal)

### ✅ Voraussetzungen
- Raspberry Pi OS
- Node.js (LTS empfohlen)
- Optional: Git, npm

### ⚡ Schnellstart
1. Repository klonen  
   `git clone ...`
2. In die App wechseln (z.B. `pvoptimizer` oder `netznoe`)
3. Port und IP in der `server.js` konfigurieren
4. Dependencies installieren  
   `npm install`
5. Starten  
   `npm start`
6. Im Browser öffnen  
   `http://localhost:<PORT>`
7. Optional ein Service installieren und aktivieren, damit die jeweilige WebApp immer läuft und verfügbar ist

---

## 🍓 Betrieb auf Raspberry Pi (Self-Hosting)
Empfohlen für einen „immer an“-Betrieb im Heimnetz.

### 🅰️ Option A: Start per systemd (empfohlen)
- Vorteil: App startet automatisch nach Reboot und bleibt zuverlässig aktiv

### 🅱️ Option B: Start per Terminal/SSH
- Für Testbetrieb oder schnelle Updates

---

## 🛰️ Zugriff von unterwegs mit Tailscale (Smartphone)
Mit Tailscale kannst du die WebApps sicher über dein eigenes privates Netzwerk erreichbar machen, ohne Portfreigaben.

**Empfohlen:**
1. Tailscale auf Raspberry Pi und Smartphone installieren
2. Geräte verbinden (privates Mesh/VPN)
3. WebApp über die Tailscale-IP oder den Gerätenamen öffnen
4. ⭐ Optional: Als Homescreen-Verknüpfung speichern (fühlt sich wie eine App an)

---

## 📤 Datenexport (Excel)
Viele Ansichten unterstützen den Export als Excel-Datei – z.B. für Archivierung oder eigene Auswertungen in Excel.
So kannst du deine Daten langfristig sichern und flexibel weiterverarbeiten.

---

## 🗂️ Ordnerstruktur (Beispiel)
- `pvoptimizer/` – PV Neigungsrechner (Node.js WebApp)
- `netznoe/` – NetzNÖ Zählerstand (Node.js WebApp)

---

## 📄 Lizenz
Dieses Projekt ist unter der **MIT License** lizenziert – du darfst den Code frei nutzen, kopieren, ändern, zusammenführen,
veröffentlichen, verbreiten, unterlizenzieren und/oder verkaufen, solange der Copyright-Hinweis und der Lizenztext erhalten bleiben.

---

## ⚠️ Hinweis / Haftungsausschluss
Private Hobby-Projekte – Nutzung auf eigenes Risiko.
