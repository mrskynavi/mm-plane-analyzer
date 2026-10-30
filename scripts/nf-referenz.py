# Referenzwerte aus dem Python-Original von NeuralFoil für die Tests (test/fixtures/nf-referenz.json).
# Aufruf in einer Umgebung mit `pip install neuralfoil==0.3.3`: python3 scripts/nf-referenz.py
import json
from pathlib import Path
import numpy as np
import aerosandbox as asb
import neuralfoil as nf
from aerosandbox.geometry.airfoil.airfoil_families import get_kulfan_parameters

root = Path(__file__).resolve().parent.parent
cases = []
for name in ['e374', 'hq309', 'rg15', 'ht14']:
    af = asb.Airfoil(name=name, coordinates=str(root / 'web' / 'profile' / f'{name}.dat'))
    coords = af.coordinates
    k = get_kulfan_parameters(coords, normalize_coordinates=True)
    alphas = [-4.0, -1.0, 0.0, 2.5, 6.0, 10.0]
    for Re, ncrit in [(1e5, 9.0), (2.5e5, 9.0), (6e5, 12.0)]:
        aero = nf.get_aero_from_coordinates(coords, alpha=np.array(alphas), Re=Re, n_crit=ncrit, model_size='xlarge')
        cases.append({
            'profil': name, 'Re': Re, 'ncrit': ncrit, 'alpha': alphas,
            'CL': aero['CL'].tolist(), 'CD': aero['CD'].tolist(), 'CM': aero['CM'].tolist(),
            'Top_Xtr': aero['Top_Xtr'].tolist(), 'Bot_Xtr': aero['Bot_Xtr'].tolist(),
            'conf': aero['analysis_confidence'].tolist(),
        })
    cases[-1]['kulfan'] = {kk: (np.asarray(v).tolist()) for kk, v in k.items()}
    cases[-1]['kulfan_profil'] = name

(root / 'test' / 'fixtures' / 'nf-referenz.json').write_text(json.dumps(cases, indent=1))
print(len(cases), 'Fälle')
