-- MM Flight Analyzer: Polaren für das MacCready-Widget, geschrieben 2026-10-11 (Testdatei)
-- Sinken (m/s, positiv) = a*v^2 + b*v + c, v in m/s; vMin/vMax = gültiger Bereich in m/s
-- Wird von der App überschrieben, bitte nicht von Hand ändern.
return {
  ["SB-10"] = { a = 0.0072013, b = -0.16246, c = 1.5137, vMin = 6.7, vMax = 18.9 },
  ["Lak-17"] = { a = 0.0050388, b = -0.10773, c = 0.97873, vMin = 10.0, vMax = 23.3 },
  ["Shark"] = { a = -0.0058039, b = 0.11161, c = -0.68627, vMin = 11.1, vMax = 28.9 },

}
