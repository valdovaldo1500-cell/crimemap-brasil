const API = '';

export async function fetchHeatmapMunicipios(p: any = {}) {
  const params = new URLSearchParams();
  Object.entries(p).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(val => params.append(k, String(val)));
    else if (v !== undefined && v !== null) params.set(k, String(v));
  });
  return (await fetch(`${API}/api/heatmap/municipios?${params}`)).json();
}
export async function fetchHeatmapBairros(p: any = {}) {
  const params = new URLSearchParams();
  Object.entries(p).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(val => params.append(k, String(val)));
    else if (v !== undefined && v !== null) params.set(k, String(v));
  });
  return (await fetch(`${API}/api/heatmap/bairros?${params}`)).json();
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
export async function fetchAutocomplete(q: string) {
  return (await fetch(`${API}/api/autocomplete?q=${encodeURIComponent(q)}`)).json();
}
