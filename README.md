# MM Plane Analyzer

Auslegung von Modellflugzeugen von Mächler Modelle: Profile, Polaren, Schwerpunkt, EWD und Festigkeit.

Stand: **P3** (Wölbklappen und Strak-Optimierer). Konzept und Roadmap: siehe Projekt „Plane Analyzer“.

## Was P0 kann

Modell (P1):

- Flügel und Höhenleitwerk als Stationen wie in XFLR5: Spannweite, Tiefe, Versatz, V-Form, Schränkung, Profil mit eigener Dicke und Wölbung, Klappentiefe und -ausschlag
- Wirbelgitterverfahren (VLM, `web/core/vlm.js`): Neutralpunkt, Schwerpunkt aus Stabilitätsmass oder Lage, Trimm auf ein Ca mit Anstellwinkel, Leitwerkseinstellung und EWD, Auftriebsverteilung mit örtlichem Ca max der Profile
- Gegenprobe mit der Handrechnung aus dem bisherigen Excel-Blatt
- Arbeitstabelle: pro Ca die EWD bei σ 15/20/25 % (oder festem Schwerpunkt), Schwerpunkt für ein unbelastetes Leitwerk, Gleitzahl und Sinken
- Excel-Import aus dem Blatt „Masse, SP“
- mehrere Modelle pro Projekt

Rumpf und Gesamtpolare (P2):

- Rumpf als feste Form (Stabrumpf, Keulenrumpf mit kleinem oder grossem Stirnwiderstand) mit Länge vor dem Flügel, Durchmesser und Seitenleitwerksfläche (`web/core/rumpf.js`)
- Rumpfwiderstand aus benetzter Fläche, Plattenreibung und Formfaktor nach Hoerner; Seitenleitwerk mit dem Leitwerksprofil
- Rumpfmoment nach Multhopp mit dem Auf- und Abwind aus dem Wirbelgitter: verschiebt Neutralpunkt, Trimm und EWD
- Gesamtpolare mit induziertem Widerstand aus der Trefftz-Ebene: Geschwindigkeitspolare, Gleitzahl über V, Widerstandsanteile, Ca über Cw; weitere Modelle zum Vergleich

Wölbklappen und Strak-Optimierer (P3):

- Flugzustände je Modell (z. B. Speed, Gleiten, Thermik) mit Ca, Klappenwinkel und Gewicht: Geschwindigkeit, EWD, Gleitzahl, Sinken und Abrissreserve; „Beste Klappe suchen“ je Zustand
- Wölbanteil je Klappe (Querruder z. B. 60 %); die Stationspolaren werden mit ausgeschlagener Klappe gerechnet
- Klappenschar: Gesamtpolare für mehrere Klappenwinkel mit Hüllkurve und Tabelle beste Klappe, EWD je Ca
- Kreisflug in der Thermik: je Kreisradius die Klappe, das Ca, die Querneigung, Fahrt, Sinken und Höhenruder mit dem geringsten Sinken, aus der Klappenschar. Lastvielfaches n = 1/cos φ, Sinken mal n^1,5, Innenflügel langsamer und mit einstellbarem Abstand zum Abriss, Nickdrehung im Höhenruder
- Strak-Optimierer (`web/core/strak.js`): Wurzelprofil vorgegeben, Dicke, Dickenrücklage, Wölbung und Wölbungsrücklage je Station und Klappenwinkel je Flugzustand gemeinsam gesucht (CMA-ES im Web Worker). Ziel: kleinster gewichteter Gesamtwiderstand, jeder Zustand getrimmt. Randbedingungen: Mindestdicke in % und mm, Abstand zum Abriss, Cm0-Grenze, glatter Strak
- Ergebnis als Vorher/Nachher-Tabelle mit Gegenprobe durch die normale Modellrechnung; Übernahme ins Modell oder als neues Modell erst auf Knopfdruck
- Stationen haben dazu Dicken- und Wölbungsrücklage

Damit eine Bewertung nur etwa 30 bis 60 ms braucht, rechnet der Optimierer vereinfacht: Das Gleichungssystem des Wirbelgitters wird einmal zerlegt (Wölbung und Klappe ändern nur die rechte Seite), die Klappe ist ein Knick der Skelettlinie auf festen x-Stellen (Kulfan-Anpassung als Matrixprodukt) und pro Station und Zustand gibt es nur wenige NeuralFoil-Punkte um das örtliche Ca. Die Tests vergleichen das mit der normalen Modellrechnung (Gleitzahl auf 3 %).

Profil-Labor:

- Profildatenbank links: .dat einlesen (Selig und Lednicer, auch mit Dezimalkomma, per Dialog oder Ziehen und Ablegen), Bibliothek mit Segler- und Leitwerksprofilen (UIUC) und NACA-4-Ziffern, umbenennen, als .dat exportieren, entfernen
- Zwei Arbeitskarten A und B: Dicke, Dickenrücklage, Wölbung, Wölbungsrücklage und Wölbklappe mit Schiebern ändern (wie XFOIL TFAC/HIGH), Polaren rechnen sofort mit
- Einsatzbereich (Thermik, Allround, Speed oder eigener Ca-Bereich), Flächenbelastung und Profiltiefe; Polaren Typ 2 (Re·√Ca fest)
- Kennzahl Cw Mittel im Einsatzbereich, dazu E max, Ca^1,5/Cw, Ca max, Cm0; Vergleichstabelle mit wählbarem Bezug
- Zustände merken, einblenden, in A oder B laden und als Profil speichern
- Polaren im Detail: Reihen über Klappenstellungen oder Re·√Ca mit Hüllkurve, Anstellwinkelbereich, Diagramme gross, Punktetabelle mit Umschlagpunkten und Konfidenz
- Projektdatei (`.mmpa.json`) speichern und öffnen; im Browser wird automatisch zwischengespeichert
- Projektordner in den Einstellungen (Chrome, Edge): Projekte direkt in einem Ordner auf dem Rechner oder einem Netzlaufwerk speichern und von dort öffnen, auf Wunsch automatisch bei jeder Änderung (`web/core/ordner.js`, File System Access API). Andere Browser speichern per Download

## Polarenrechnung

Die Polaren rechnet [NeuralFoil](https://github.com/peterdsharpe/NeuralFoil) (Peter Sharpe, MIT-Lizenz), hier nach JavaScript übertragen (`web/core/neuralfoil.js`). Das Netz ist auf XFOIL-Rechnungen trainiert, konvergiert immer und liefert eine Konfidenz pro Punkt. Die Tests vergleichen die JavaScript-Fassung mit dem Python-Original (Abweichung unter 1e-9). XFOIL selbst soll später über die Desktop-App dazukommen.

## Aufbau

```
web/index.html          Oberfläche (gleicher Stil wie MM Flight Analyzer, Chart.js)
web/core/profil.js      Geometrie: .dat lesen, normieren, neu verteilen, Dicke/Wölbung, Klappe
web/core/neuralfoil.js  NeuralFoil: Kulfan-Anpassung und Netz
web/core/nf-gewichte.js Netzgewichte (erzeugt)
web/core/polare.js      Polaren Typ 1/2, Kennwerte, Hüllkurve
web/core/vlm.js         Wirbelgitter: Panels, Hufeisenwirbel, Lösung, Beiwerte
web/core/modell.js      Modellrechnung: Neutralpunkt, Trimm, EWD, Handrechnung, Arbeitstabelle, Gesamtpolare
web/core/rumpf.js       Rumpfform, Rumpf- und Seitenleitwerkswiderstand, Rumpfmoment
web/core/ordner.js      Projektordner: Ordner wählen und merken, Projekte lesen und schreiben
web/core/excel.js       Modell aus dem Excel-Blatt „Masse, SP“
web/core/strak.js       Strak-Optimierer, Flugzustände, Klappenschar, Kreisflug
web/core/strak-worker.js  Optimierer im Hintergrund (Web Worker)
web/core/projekt.js     Projektdatei, Fingerabdruck der Polaren, Modell-Grundgerüst für P1
web/core/bibliothek.js  mitgelieferte Profile (erzeugt aus web/profile/*.dat)
```

Die Kernmodule laufen im Browser und in Node ohne Abhängigkeiten.

## Entwicklung

```
npm test                       # Tests (node --test)
node scripts/bibliothek.js     # web/profile/*.dat nach web/core/bibliothek.js
```

Online: https://mrskynavi.github.io/mm-plane-analyzer/ (wird bei jedem Push auf main neu veröffentlicht, `.github/workflows/pages.yml`). Lokal genügt es, `web/index.html` direkt im Browser zu öffnen. Die Netzgewichte und Referenzwerte entstehen mit Python und `pip install neuralfoil==0.3.3`:

```
python3 scripts/nf-gewichte.py <site-packages>/neuralfoil/nn_weights_and_biases xlarge
python3 scripts/nf-referenz.py
```
