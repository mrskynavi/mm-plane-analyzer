# MM Plane Analyzer

Auslegung von Modellflugzeugen von Mächler Modelle: Profile, Polaren, Schwerpunkt, EWD und Festigkeit.

Stand: **P0** (Rechenkern und Profile). Konzept und Roadmap: siehe Projekt „Plane Analyzer“.

## Was P0 kann

Modell (P1):

- Flügel und Höhenleitwerk als Stationen wie in XFLR5: Spannweite, Tiefe, Versatz, V-Form, Schränkung, Profil mit eigener Dicke und Wölbung, Klappentiefe und -ausschlag
- Wirbelgitterverfahren (VLM, `web/core/vlm.js`): Neutralpunkt, Schwerpunkt aus Stabilitätsmass oder Lage, Trimm auf ein Ca mit Anstellwinkel, Leitwerkseinstellung und EWD, Auftriebsverteilung mit örtlichem Ca max der Profile
- Gegenprobe mit der Handrechnung aus dem bisherigen Excel-Blatt
- mehrere Modelle pro Projekt

Profil-Labor:

- Profildatenbank links: .dat einlesen (Selig und Lednicer, auch mit Dezimalkomma, per Dialog oder Ziehen und Ablegen), Bibliothek mit Segler- und Leitwerksprofilen (UIUC) und NACA-4-Ziffern, umbenennen, als .dat exportieren, entfernen
- Zwei Arbeitskarten A und B: Dicke, Dickenrücklage, Wölbung, Wölbungsrücklage und Wölbklappe mit Schiebern ändern (wie XFOIL TFAC/HIGH), Polaren rechnen sofort mit
- Einsatzbereich (Thermik, Allround, Speed oder eigener Ca-Bereich), Flächenbelastung und Profiltiefe; Polaren Typ 2 (Re·√Ca fest)
- Kennzahl Cw Mittel im Einsatzbereich, dazu E max, Ca^1,5/Cw, Ca max, Cm0; Vergleichstabelle mit wählbarem Bezug
- Zustände merken, einblenden, in A oder B laden und als Profil speichern
- Polaren im Detail: Reihen über Klappenstellungen oder Re·√Ca mit Hüllkurve, Anstellwinkelbereich, Diagramme gross, Punktetabelle mit Umschlagpunkten und Konfidenz
- Projektdatei (`.mmpa.json`) speichern und öffnen; im Browser wird automatisch zwischengespeichert

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
web/core/modell.js      Modellrechnung: Neutralpunkt, Trimm, EWD, Handrechnung
web/core/projekt.js     Projektdatei, Fingerabdruck der Polaren, Modell-Grundgerüst für P1
web/core/bibliothek.js  mitgelieferte Profile (erzeugt aus web/profile/*.dat)
```

Die Kernmodule laufen im Browser und in Node ohne Abhängigkeiten.

## Entwicklung

```
npm test                       # Tests (node --test)
node scripts/bibliothek.js     # web/profile/*.dat nach web/core/bibliothek.js
```

`web/index.html` direkt im Browser öffnen genügt. Die Netzgewichte und Referenzwerte entstehen mit Python und `pip install neuralfoil==0.3.3`:

```
python3 scripts/nf-gewichte.py <site-packages>/neuralfoil/nn_weights_and_biases xlarge
python3 scripts/nf-referenz.py
```
