const API = '';

export async function fetchHeatmapMunicipios(p: any = {}) {
  const qs = new URLSearchParams(p).toString();
  return (await fetch(`${API}/api/heatmap/municipios?${qs}`)).json();
}
export async function fetchHeatmapBairros(p: any = {}) {
  const qs = new URLSearchParams(p).toString();
  return (await fetch(`${API}/api/heatmap/bairros?${qs}`)).json();
}
export async function fetchCrimes(p: any = {}) {
  const qs = new URLSearchParams(p).toString();
  return (await fetch(`${API}/api/crimes?${qs}`)).json();
}
export async function fetchCrimeTypes() {
  return (await fetch(`${API}/api/crime-types`)).json();
}
export async function fetchMunicipios() {
  return (await fetch(`${API}/api/municipios`)).json();
}
export async function fetchStats(p: any = {}) {
  const qs = new URLSearchParams(p).toString();
  return (await fetch(`${API}/api/stats?${qs}`)).json();
}
export async function searchLocation(q: string) {
  return (await fetch(`${API}/api/search?q=${encodeURIComponent(q)}`)).json();
}
