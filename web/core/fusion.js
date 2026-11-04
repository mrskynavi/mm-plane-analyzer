// Export nach Autodesk Fusion: Profilschnitte der Stationen von Flügel oder Höhenleitwerk im Raum
// (mit Tiefe, Pfeilung, V-Form, Schränkung, Dicke/Wölbung/Rücklagen und Endleistendicke, wie gerechnet)
// und daraus ein Python-Skript für Fusion, das je Station eine Skizze mit Profil-Spline anlegt und
// die Skizzen zu einem Volumenkörper loftet. Längen in mm, App-Achsen: x nach hinten, y Spannweite, z oben.
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const M = isNode ? require('./modell.js') : root.MMPA.modell;
  const V = isNode ? require('./vlm.js') : root.MMPA.vlm;
  const P = isNode ? require('./profil.js') : root.MMPA.profil;

  const RAD = Math.PI / 180;
  const TIP_F = [0.85, 0.65, 0.45, 0.3]; // Tiefe der Ellipsenschnitte am Randbogen, Anteil der letzten Station
  const STEP = 100; // mm: grösster Abstand der Schnitte, dazwischen lineare Zwischenschnitte
  // Profile aus Messungen (3MF, Rhino) haben feine Wellen; 100 Punkte je Seite mit Wellen bringen den
  // Fitted Spline in Fusion zum Schwingen und den Loft zum Selbstschnitt. Darum je Seite N_SIDE Punkte
  // (Kosinusteilung) und Dicke und Wölbung leicht geglättet (Abweichung meist unter 0,1 mm).
  const N_SIDE = 50, PASSES = 2;
  function glatt(geo, n, passes) {
    const x = P.cosspace(n), { t, c } = P.thicknessCamber(geo, x);
    const sm = a => {
      let b = a.slice();
      for (let k = 0; k < passes; k++) { const o = b.slice(); for (let i = 2; i < b.length - 1; i++) o[i] = (b[i - 1] + 2 * b[i] + b[i + 1]) / 4; b = o; }
      return b;
    };
    const ts = sm(t), cs = sm(c);
    const up = x.map((xv, k) => [xv, cs[k] + ts[k] / 2]), lo = x.map((xv, k) => [xv, cs[k] - ts[k] / 2]);
    return up.slice().reverse().concat(lo.slice(1));
  }
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

  function startIndex(st, opts = {}) {
    if (opts.all) return 0;
    if (Number.isFinite(opts.fromY)) {
      const k = st.findIndex(s => s.y >= opts.fromY - 1e-6);
      if (k >= 0) return Math.min(k, st.length - 2);
    }
    return firstStation(st);
  }

  // Schnitte einer Fläche. part 'wing' | 'tail'. Ursprung = Nasenleiste der ersten ausgegebenen Station.
  // opts.fromY: ab der Station mit diesem y (mm, gewählt in der App), opts.all: alle Stationen,
  // sonst ab der ersten Station ausserhalb des Rumpfs (firstStation).
  function sections(model, profiles, part = 'wing', opts = {}) {
    const R = M.resolveTe(model);
    const st = R[part].stations;
    if (!st || st.length < 2) throw new Error('Mindestens zwei Stationen nötig');
    const k0 = startIndex(st, opts);
    const P = V.stationPoints(st);
    const o = P[k0].le, y0 = st[k0].y;
    const out = [], missing = [];
    for (let i = k0; i < st.length; i++) {
      const s = st[i], g = M.stationGeometry(s, profiles);
      if (!g) { missing.push(Math.round(s.y)); continue; }
      const c = s.chord, tw = (s.twist || 0) * RAD, ct = Math.cos(tw), sn = Math.sin(tw);
      const geo = opts.raw ? g.geo.map(p => p.slice()) : glatt(g.geo, opts.n || N_SIDE, opts.passes ?? PASSES);
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
      // Ellipsenschnitte zwischen letzter Station und Spitze: Tiefe c = c_letzt·f mit c² linear im Abstand,
      // Profil der letzten Station um seine Mitte verkleinert, Mitte auf der Linie zur Spitze.
      // So läuft der Loft auch ganz aussen auf der Ellipse statt gerade in den Punkt.
      TIP_F.forEach((fr, ri) => {
        const e = 1 - fr * fr, m = [0, 1, 2].map(k => mb[k] + (tip.pt[k] - mb[k]) * e);
        all.push({ name: nameOf(part, b.y) + '_Rand' + (ri + 1), y: b.y + d * e, chord: b.chord * fr, te: b.te * fr, kink: false, between: true, tipSection: true,
          pts: b.pts.map(p => [m[0] + (p[0] - mb[0]) * fr, m[1], m[2] + (p[2] - mb[2]) * fr]) });
      });
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
RANDSPITZE = ${r.tip ? 'True ' : 'False'}  # True: Loft läuft über die Ellipsenschnitte (_Rand1…4) bis in den Punkt, wo die Tiefe null wird
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

            spitze = None
            if RANDSPITZE and SPITZE:
                pin = comp.constructionPlanes.createInput()
                pin.setByOffset(comp.yZConstructionPlane, adsk.core.ValueInput.createByReal(punkt(SPITZE).x))
                ebene = comp.constructionPlanes.add(pin)
                ebene.name = 'Randspitze'
                sk = comp.sketches.add(ebene)
                sk.name = 'Randspitze'
                spitze = sk.sketchPoints.add(sk.modelToSketchSpace(punkt(SPITZE)))
            # ein Loft je Abschnitt zwischen den Knicken der V-Form, die weiteren werden angefügt.
            # Der letzte Abschnitt läuft über die Ellipsenschnitte des Randbogens bis in die Spitze.
            # Lehnt Fusion das ab: ohne Spitze (Ende im kleinsten Ellipsenschnitt), sonst Station für Station.
            grenzen = [0] + knicke + [len(profile) - 1]
            for g in range(len(grenzen) - 1):
                teile = profile[grenzen[g]:grenzen[g + 1] + 1]
                letzter = g == len(grenzen) - 2
                if letzter and spitze is not None and loft(teile + [spitze]):
                    continue
                if loft(teile):
                    if letzter and spitze is not None:
                        notiz.append('Randbogen endet im kleinsten Ellipsenschnitt statt in der Spitze')
                    continue
                for k in range(len(teile) - 1):
                    if not loft(teile[k:k + 2]):
                        notiz.append('Loft ' + STATIONEN[grenzen[g] + k][0] + ' bis ' + STATIONEN[grenzen[g] + k + 1][0] + ' fehlgeschlagen')
                notiz.append('Abschnitt ab ' + STATIONEN[grenzen[g]][0] + ' Station für Station gelofted (Kanten an den Stationen)')
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

  const api = { startIndex, glatt, N_SIDE, PASSES, sections, script, scriptZip, zip, crc32, manifest, fileName, firstStation, MIN_TE, STEP };
  if (isNode) module.exports = api;
  else (root.MMPA = root.MMPA || {}).fusion = api;
})(typeof self !== 'undefined' ? self : this);
