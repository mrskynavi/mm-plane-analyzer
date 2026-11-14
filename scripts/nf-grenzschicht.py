# Referenzwerte der Grenzschicht aus dem Python-Original von NeuralFoil (test/fixtures/nf-grenzschicht.json).
# Aufruf in einer Umgebung mit `pip install neuralfoil==0.3.3`: python3 scripts/nf-grenzschicht.py
import json
from pathlib import Path
import numpy as np
import aerosandbox as asb
import neuralfoil as nf

root = Path(__file__).resolve().parent.parent
N = len(nf.bl_x_points)
cases = []
for name, Re, ncrit in [('e374', 1e5, 9.0), ('rg15', 3e5, 9.0), ('hq309', 2e5, 7.0)]:
    coords = asb.Airfoil(name=name, coordinates=str(root / 'web' / 'profile' / f'{name}.dat')).coordinates
    alphas = [-3.0, 0.0, 4.0, 8.0, 12.0]
    aero = nf.get_aero_from_coordinates(coords, alpha=np.array(alphas), Re=Re, n_crit=ncrit, model_size='xlarge')
    case = {'profil': name, 'Re': Re, 'ncrit': ncrit, 'alpha': alphas, 'x': nf.bl_x_points.tolist()}
    for side in ['upper', 'lower']:
        for q in ['theta', 'H', 'ue/vinf']:
            case[f'{side}_{q}'] = [[float(aero[f'{side}_bl_{q}_{i}'][j]) for i in range(N)] for j in range(len(alphas))]
    cases.append(case)
(root / 'test' / 'fixtures' / 'nf-grenzschicht.json').write_text(json.dumps(cases))
print(len(cases), 'Fälle')
