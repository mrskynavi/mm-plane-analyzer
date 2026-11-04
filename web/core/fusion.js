// Export nach Autodesk Fusion: Profilschnitte der Stationen von Flügel oder Höhenleitwerk im Raum
// (mit Tiefe, Pfeilung, V-Form, Schränkung, Dicke/Wölbung/Rücklagen und Endleistendicke, wie gerechnet)
// und daraus ein Python-Skript für Fusion, das je Station eine Skizze mit Profil-Spline anlegt und
// die Skizzen zu einem Volumenkörper loftet. Längen in mm, App-Achsen: x nach hinten, y Spannweite, z oben.
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const M = isNode ? require('./modell.js') : root.MMPA.modell;
  const V = isNode ? require('./vlm.js') : root.MMPA.vlm;

  const RAD = Math.PI / 180;
  const STEP = 100; // mm: grösster Abstand der Schnitte, dazwischen lineare Zwischenschnitte
  const nameOf = (part, d) => `${part === 'wing' ? 'WG' : 'HLW'}_Y${String(Math.round(d)).padStart(4, '0')}`;
  const MIN_TE = 0.05; // mm: Fusion braucht eine offene Endleiste, damit die Skizze eine Fläche schliesst

  // Stationen innen, die nur den Flügel im Rumpf verlängern (gleiche Tiefe, Lage und gleiches Profil wie die nächste)
  const same = (a, b) => a.chord === b.chord && (a.offset || 0) === (b.offset || 0) && a.profileId === b.profileId &&
    a.thickness === b.thickness && a.camber === b.camber && (a.twist || 0) === (b.twist || 0);
  function firstStation(stations) {
    let k = 0;
    while (k + 2 < stations.length && same(stations[k], stations[k + 1])) k++;
    return k;
  }

  // Schnitte einer Fläche. part 'wing' | 'tail'. Ursprung = Nasenleiste der ersten ausgegebenen Station.
  // opts.fromRoot: Stationen im Rumpf weglassen (Standard true), opts.all: alle Stationen.
  function sections(model, profiles, part = 'wing', opts = {}) {
    const R = M.resolveTe(model);
    const st = R[part].stations;
    if (!st || st.length < 2) throw new Error('Mindestens zwei Stationen nötig');
    const k0 = opts.all ? 0 : firstStation(st);
    const P = V.stationPoints(st);
    const o = P[k0].le, y0 = st[k0].y;
    const out = [], missing = [];
    for (let i = k0; i < st.length; i++) {
      const s = st[i], g = M.stationGeometry(s, profiles);
      if (!g) { missing.push(Math.round(s.y)); continue; }
      const c = s.chord, tw = (s.twist || 0) * RAD, ct = Math.cos(tw), sn = Math.sin(tw);
      const geo = g.geo.map(p => p.slice());
      // Endleiste mindestens MIN_TE offen, sanft über die hinteren 20 %
      const n = geo.length, gap = (geo[0][1] - geo[n - 1][1]) * c;
      if (gap < MIN_TE) {
        const d = (MIN_TE - gap) / 2 / c;
        const iLe = geo.reduce((b, p, j) => (p[0] < geo[b][0] ? j : b), 0);
        geo.forEach((p, j) => { const w = Math.max(0, (p[0] - 0.8) / 0.2); p[1] += (j < iLe ? d : j > iLe ? -d : 0) * w; });
      }
      const le = P[i].le;
      // Schränkung um die Nasenleiste, positiv = Nase hoch
      const pts = geo.map(([x, z]) => {
        const xr = x * c * ct + z * c * sn, zr = z * c * ct - x * c * sn;
        return [le[0] - o[0] + xr, le[1] - o[1], le[2] - o[2] + zr];
      });
      const dist = s.y - y0;
      // Knick der V-Form: dort endet ein Loft und der nächste beginnt, sonst rundet Fusion den Knick aus
      const kink = i > k0 && i < st.length - 1 && (st[i - 1].dihedral || 0) !== (s.dihedral || 0);
      out.push({ name: nameOf(part, dist), y: dist, chord: c, te: Math.max(MIN_TE, gap), kink, pts });
    }
    // Zwischenschnitte in langen Segmenten, linear wie in der App gerechnet, damit der Loft zwischen
    // weit auseinanderliegenden Stationen nicht ausbaucht (gerade Nasen- und Endleiste bleiben gerade)
    const step = opts.step || STEP;
    const all = [];
    out.forEach((b, j) => {
      const a = out[j - 1];
      if (a && b.y - a.y > step) {
        const n = Math.ceil((b.y - a.y) / step);
        for (let k = 1; k < n; k++) {
          const t = k / n, y = a.y + (b.y - a.y) * t;
          all.push({ name: nameOf(part, y) + '_z', y, chord: a.chord + (b.chord - a.chord) * t, te: a.te + (b.te - a.te) * t, kink: false, between: true,
            pts: a.pts.map((p, m) => p.map((v, q) => v + (b.pts[m][q] - v) * t)) });
        }
      }
      all.push(b);
    });
    // Randbogen: aus den letzten zwei Stationen hochrechnen, wo die Tiefe null wird (Ellipse: c² fällt
    // linear zur Spitze hin), und den Punkt in der Profilmitte dort als Ende des Lofts.
    let tip = null;
    const a = out[out.length - 2], b = out[out.length - 1], cMax = Math.max(...out.map(q => q.chord));
    if (a && b && b.chord < a.chord && b.chord < 0.5 * cMax && b.y > a.y) {
      const dy = b.y - a.y, d = Math.min(dy, b.chord * b.chord / ((a.chord * a.chord - b.chord * b.chord) / dy));
      const mid = q => {
        const iLe = q.pts.reduce((m, p, j) => (p[0] < q.pts[m][0] ? j : m), 0), xs = q.pts[iLe][0] + q.chord / 2;
        const near = list => list.reduce((m, p) => (Math.abs(p[0] - xs) < Math.abs(m[0] - xs) ? p : m));
        const u = near(q.pts.slice(0, iLe + 1)), l = near(q.pts.slice(iLe));
        return [0, 1, 2].map(k => (u[k] + l[k]) / 2);
      };
      const ma = mid(a), mb = mid(b), t = d / dy;
      tip = { dist: d, pt: [0, 1, 2].map(k => mb[k] + (mb[k] - ma[k]) * t) };
    }
    const maxDihedral = Math.max(...st.slice(k0).map(s => Math.abs(s.dihedral || 0)));
    return { part, start: y0, skipped: k0, stations: out, sections: all, tip, missing, maxDihedral };
  }

  const f = v => (Math.round(v * 1e4) / 1e4).toString();
  const pyStr = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]+/g, ' ') + "'";

  // Python-Skript für Fusion (Dienstprogramme → Add-Ins → Skripte und Add-Ins → Erstellen → Python,
  // oder die Datei als Skript einbinden). Erzeugt eine neue Komponente mit Skizzen und Loft.
  function script(model, profiles, part = 'wing', opts = {}) {
    const r = sections(model, profiles, part, opts);
    if (r.sections.length < 2) throw new Error('Zu wenige Stationen mit Profil');
    const label = (part === 'wing' ? 'Flügel' : 'HLW') + ' ' + (model.name || '');
    const data = r.sections.map(s => `    (${pyStr(s.name)}, ${s.kink ? 'True' : 'False'}, [\n` +
      s.pts.map(p => `        (${f(p[0])}, ${f(p[1])}, ${f(p[2])}),`).join('\n') + '\n    ]),').join('\n');
    const head = [
      `# ${label.trim()} für Autodesk Fusion, erzeugt von MM Plane Analyzer am ${new Date().toISOString().slice(0, 10)}`,
      '#',
      '# In Fusion: Dienstprogramme → Add-Ins → Skripte und Zusatzmodule (Shift+S) → „+“ → „Skript oder Zusatzmodul',
      '# von Gerät“ und den Ordner mit dieser Datei und der .manifest-Datei wählen (aus dem ZIP der App), dann Ausführen.',
      '# Oder: „Skript oder Zusatzmodul erstellen“ → Python, im Editor den Inhalt durch diese Datei ersetzen.',
      '# Das Skript legt im aktiven Design eine neue Komponente an: je Station eine Skizze mit dem Profil',
      '# als Spline und der Endleiste als Linie, dann einen Loft zum Volumenkörper (eine Hälfte).',
      '#',
      `# Achsen: X = Spannweite ab der ${r.skipped ? `Station bei ${f(r.start)} mm (Stationen im Rumpf weggelassen)` : 'ersten Station'},`,
      '# Höhe und Tiefe je nach HOCH unten. Nullpunkt = Nasenleiste dieser Station. Masse in mm.',
      '# Schnitte stehen senkrecht (wie in der App gerechnet), nicht quer zur V-Form.',
    ];
    if (r.maxDihedral > 10) head.push(`# Achtung: V-Form bis ${f(r.maxDihedral)}°, die senkrechten Schnitte sind dort um cos(V-Form) zu dünn.`);
    return head.join('\n') + `

import adsk.core, adsk.fusion, traceback

NAME = ${pyStr(label.trim())}
LOFT = True     # False: nur die Skizzen, z. B. um sie im bestehenden Loft zu tauschen
HOCH = 'Y'      # 'Y': Y nach oben, Z nach hinten (Fusion-Standard); 'Z': Z nach oben, Y nach hinten
SPIEGELN = False  # True: Spannweite nach -X (linke Hälfte)
RANDSPITZE = ${r.tip ? 'True ' : 'False'}  # True: Loft endet im Punkt, wo die Randbogen-Ellipse auf Tiefe null kommt
SPITZE = ${r.tip ? `(${r.tip.pt.map(f).join(', ')})  # ${f(r.tip.dist)} mm ausserhalb der letzten Station` : 'None'}

# Station, Knick der V-Form (dort beginnt ein neuer Loft), Punkte (x nach hinten, y Spannweite, z oben) in mm, von der Endleiste oben über die Nase zur Endleiste unten
STATIONEN = [
${data}
]


def punkt(p):
    x, y, z = p[0] / 10.0, p[1] / 10.0, p[2] / 10.0  # Fusion rechnet intern in cm
    if SPIEGELN:
        y = -y
    if HOCH == 'Z':
        return adsk.core.Point3D.create(y, x, z)
    return adsk.core.Point3D.create(y, z, x)


def skizze(comp, name, pts):
    pin = comp.constructionPlanes.createInput()
    pin.setByOffset(comp.yZConstructionPlane, adsk.core.ValueInput.createByReal(punkt(pts[0]).x))
    ebene = comp.constructionPlanes.add(pin)
    ebene.name = name
    sk = comp.sketches.add(ebene)
    sk.name = name
    sk.isComputeDeferred = True
    coll = adsk.core.ObjectCollection.create()
    for p in pts:
        coll.add(sk.modelToSketchSpace(punkt(p)))
    spl = sk.sketchCurves.sketchFittedSplines.add(coll)
    sk.sketchCurves.sketchLines.addByTwoPoints(spl.startSketchPoint, spl.endSketchPoint)
    sk.isComputeDeferred = False
    if sk.profiles.count < 1:
        raise Exception('Skizze ' + name + ' ist nicht geschlossen.')
    return sk.profiles.item(0)


def run(context):
    ui = None
    try:
        app = adsk.core.Application.get()
        ui = app.userInterface
        design = adsk.fusion.Design.cast(app.activeProduct)
        if not design:
            ui.messageBox('Bitte zuerst ein Design öffnen.')
            return
        occ = design.rootComponent.occurrences.addNewComponent(adsk.core.Matrix3D.create())
        comp = occ.component
        comp.name = NAME
        profile = []
        knicke = []
        for name, knick, pts in STATIONEN:
            profile.append(skizze(comp, name, pts))
            if knick:
                knicke.append(len(profile) - 1)
        notiz = []
        if LOFT:
            lofts = comp.features.loftFeatures
            zustand = {'koerper': None}

            def loft(teile):
                op = adsk.fusion.FeatureOperations.NewBodyFeatureOperation if zustand['koerper'] is None else adsk.fusion.FeatureOperations.JoinFeatureOperation
                li = lofts.createInput(op)
                for pr in teile:
                    li.loftSections.add(pr)
                li.isSolid = True
                try:
                    f = lofts.add(li)
                except:
                    return False
                if zustand['koerper'] is None and f.bodies.count:
                    zustand['koerper'] = f.bodies.item(0)
                    zustand['koerper'].name = NAME
                return True

            # ein Loft je Abschnitt zwischen den Knicken der V-Form, die weiteren werden angefügt.
            # Lehnt Fusion einen Abschnitt ab (schneidet sich selbst), wird er Station für Station gelofted.
            grenzen = [0] + knicke + [len(profile) - 1]
            for g in range(len(grenzen) - 1):
                teile = profile[grenzen[g]:grenzen[g + 1] + 1]
                if not loft(teile):
                    for k in range(len(teile) - 1):
                        if not loft(teile[k:k + 2]):
                            notiz.append('Loft ' + STATIONEN[grenzen[g] + k][0] + ' bis ' + STATIONEN[grenzen[g] + k + 1][0] + ' fehlgeschlagen')
                    notiz.append('Abschnitt ab ' + STATIONEN[grenzen[g]][0] + ' Station für Station gelofted (Kanten an den Stationen)')
            # Randbogen: erst bis zum Punkt, sonst bis zu einem kleinen Profil (10 %), sonst flaches Ende
            if RANDSPITZE and SPITZE:
                letzte = STATIONEN[-1][2]
                ok = False
                try:
                    pin = comp.constructionPlanes.createInput()
                    pin.setByOffset(comp.yZConstructionPlane, adsk.core.ValueInput.createByReal(punkt(SPITZE).x))
                    ebene = comp.constructionPlanes.add(pin)
                    ebene.name = 'Randspitze'
                    sk = comp.sketches.add(ebene)
                    sk.name = 'Randspitze'
                    ok = loft([profile[-1], sk.sketchPoints.add(sk.modelToSketchSpace(punkt(SPITZE)))])
                except:
                    ok = False
                if not ok:
                    mitte = [(min(p[i] for p in letzte) + max(p[i] for p in letzte)) / 2 for i in range(3)]
                    klein = [[SPITZE[i] + (p[i] - mitte[i]) * 0.1 if i != 1 else SPITZE[1] for i in range(3)] for p in letzte]
                    try:
                        ok = loft([profile[-1], skizze(comp, 'Randspitze_klein', klein)])
                    except:
                        ok = False
                    notiz.append('Randbogen endet in einem kleinen Profil (10 %)' if ok else 'Randbogen ohne Spitze, Ende flach')
        ui.messageBox(NAME + ': ' + str(len(STATIONEN)) + ' Schnitte' + (' gelofted.' if LOFT else ' als Skizzen angelegt.') + ('\\n' + '\\n'.join(notiz) if notiz else ''))
    except:
        if ui:
            ui.messageBox('Fehler:\\n' + traceback.format_exc())
`;
  }

  const fileName = (model, part) => ((model.name || 'Modell') + '_' + (part === 'wing' ? 'Fluegel' : 'HLW') + '_Fusion')
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/[^A-Za-z0-9_-]+/g, '_') + '.py';

  // Fusion will beim Hinzufügen („Skript oder Zusatzmodul von Gerät“) einen Ordner mit <Name>.py und
  // <Name>.manifest. Darum ein ZIP mit diesem Ordner (ohne Kompression, Inhalt UTF-8).
  function manifest() {
    return JSON.stringify({ autodeskProduct: 'Fusion', type: 'script', author: 'MM Plane Analyzer',
      description: { '': 'Profilschnitte und Loft aus MM Plane Analyzer' }, supportedOS: 'windows|mac', editEnabled: true }, null, '\t') + '\n';
  }
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let off = 0;
    const u16 = v => [v & 255, (v >>> 8) & 255], u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
    for (const f of files) {
      const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
      // Version, Flag UTF-8 (Bit 11), Methode 0, Zeit/Datum 1.1.2026
      const common = [...u16(20), ...u16(0x800), ...u16(0), ...u16(0), ...u16(0x5C21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
      const head = Uint8Array.from([...u32(0x04034b50), ...common]);
      parts.push(head, name, data);
      central.push(Uint8Array.from([...u32(0x02014b50), ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), name);
      off += head.length + name.length + data.length;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const end = Uint8Array.from([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(off), ...u16(0)]);
    const all = parts.concat(central, [end]), out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
    let p = 0; for (const b of all) { out.set(b, p); p += b.length; }
    return out;
  }
  // ZIP mit dem Skriptordner; name ohne Endung
  function scriptZip(model, profiles, part = 'wing', opts = {}) {
    const name = fileName(model, part).replace(/\.py$/, '');
    return { name: name + '.zip', bytes: zip([{ name: name + '/' + name + '.py', data: script(model, profiles, part, opts) }, { name: name + '/' + name + '.manifest', data: manifest() }]) };
  }

  const api = { sections, script, scriptZip, zip, crc32, manifest, fileName, firstStation, MIN_TE, STEP };
  if (isNode) module.exports = api;
  else (root.MMPA = root.MMPA || {}).fusion = api;
})(typeof self !== 'undefined' ? self : this);
