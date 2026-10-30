# NeuralFoil-Gewichte (npz aus dem Python-Paket) nach web/core/nf-gewichte.js umsetzen.
# Aufruf: python3 scripts/nf-gewichte.py <pfad/zu/neuralfoil/nn_weights_and_biases> [modellgrösse]
# NeuralFoil: Peter Sharpe, MIT-Lizenz (siehe web/core/LICENSE-neuralfoil.txt).
import base64, json, sys
from pathlib import Path
import numpy as np

src = Path(sys.argv[1])
size = sys.argv[2] if len(sys.argv) > 2 else 'xlarge'
nn = np.load(src / f'nn-{size}.npz')
dist = np.load(src / 'scaled_input_distribution.npz')

def b64(a, dtype='<f4'):
    return base64.b64encode(np.ascontiguousarray(a, dtype=dtype).tobytes()).decode()

idx = sorted({int(k.split('.')[1]) for k in nn.keys()})
layers = []
for i in idx:
    w = nn[f'net.{i}.weight']
    layers.append({'rows': int(w.shape[0]), 'cols': int(w.shape[1]), 'w': b64(w), 'b': b64(nn[f'net.{i}.bias'])})

data = {
    'model': size,
    'layers': layers,
    # Verteilung in float64 wie im Original, die Gewichte sind dort float32
    'mean': b64(dist['mean_inputs_scaled'], '<f8'),
    'invCov': b64(dist['inv_cov_inputs_scaled'], '<f8'),
    'nInputs': int(len(dist['mean_inputs_scaled'])),
}
out = Path(__file__).resolve().parent.parent / 'web' / 'core' / 'nf-gewichte.js'
out.write_text(
    '// Erzeugt von scripts/nf-gewichte.py aus NeuralFoil 0.3.3 (Peter Sharpe, MIT-Lizenz). Nicht von Hand ändern.\n'
    '(function (root) {\n'
    f'  const W = {json.dumps(data)};\n'
    "  if (typeof module !== 'undefined' && module.exports) module.exports = W;\n"
    '  else (root.MMPA = root.MMPA || {}).nfGewichte = W;\n'
    "})(typeof self !== 'undefined' ? self : this);\n"
)
print(out, out.stat().st_size)
