const API = '';

export async function fetchHeatmapMunicipios(p: any = {}, signal?: AbortSignal) {
  const params = new URLSearchParams();
  Object.entries(p).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(val => params.append(k, String(val)));
    else if (v !== undefined && v !== null) params.set(k, String(v));
  });
  try {
    const res = await fetch(`${API}/api/heatmap/municipios?${params}`, { signal });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    if (err.name === 'AbortError') return [];
    throw new Error(`fetchHeatmapMunicipios failed: ${err.message}`);
  }
}

export async function fetchHeatmapBairros(p: any = {}, signal?: AbortSignal) {
  const params = new URLSearchParams();
  Object.entries(p).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(val => params.append(k, String(val)));
    else if (v !== undefined && v !== null) params.set(k, String(v));
  });
  try {
    const res = await fetch(`${API}/api/heatmap/bairros?${params}`, { signal });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    if (err.name === 'AbortError') return [];
    throw new Error(`fetchHeatmapBairros failed: ${err.message}`);
  }
}

export async function fetchCrimes(p: any = {}) {
  const qs = new URLSearchParams(p).toString();
  try {
    const res = await fetch(`${API}/api/crimes?${qs}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    throw new Error(`fetchCrimes failed: ${err.message}`);
  }
}

export async function fetchCrimeTypes() {
  try {
    const res = await fetch(`${API}/api/crime-types`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    throw new Error(`fetchCrimeTypes failed: ${err.message}`);
  }
}

export async function fetchMunicipios() {
  try {
    const res = await fetch(`${API}/api/municipios`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    throw new Error(`fetchMunicipios failed: ${err.message}`);
  }
}

export async function fetchStats(p: any = {}) {
  const qs = new URLSearchParams(p).toString();
  try {
    const res = await fetch(`${API}/api/stats?${qs}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    throw new Error(`fetchStats failed: ${err.message}`);
  }
}

export async function searchLocation(q: string) {
  try {
    const res = await fetch(`${API}/api/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    throw new Error(`searchLocation failed: ${err.message}`);
  }
}

export async function fetchGeocode(municipio: string, state?: string, bairro?: string) {
  try {
    const p = new URLSearchParams({ municipio });
    if (state) p.set('state', state);
    if (bairro) p.set('bairro', bairro);
    const res = await fetch(`${API}/api/geocode?${p}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    throw new Error(`fetchGeocode failed: ${err.message}`);
  }
}

export async function fetchYears() {
  try {
    const res = await fetch(`${API}/api/years`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    throw new Error(`fetchYears failed: ${err.message}`);
  }
}

export async function fetchSemesters() {
  try {
    const res = await fetch(`${API}/api/semesters`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    throw new Error(`fetchSemesters failed: ${err.message}`);
  }
}

export async function fetchLocationStats(p: any = {}) {
  const params = new URLSearchParams();
  Object.entries(p).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(val => params.append(k, String(val)));
    else if (v !== undefined && v !== null) params.set(k, String(v));
  });
  try {
    const res = await fetch(`${API}/api/location-stats?${params}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    throw new Error(`fetchLocationStats failed: ${err.message}`);
  }
}

export async function fetchAutocomplete(q: string, signal?: AbortSignal) {
  try {
    const res = await fetch(`${API}/api/autocomplete?q=${encodeURIComponent(q)}`, { signal });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    if (err.name === 'AbortError') return [];
    throw new Error(`fetchAutocomplete failed: ${err.message}`);
  }
}

export async function fetchSexoValues() {
  try {
    const res = await fetch(`${API}/api/sexo-values`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    throw new Error(`fetchSexoValues failed: ${err.message}`);
  }
}

export async function fetchCorValues() {
  try {
    const res = await fetch(`${API}/api/cor-values`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    throw new Error(`fetchCorValues failed: ${err.message}`);
  }
}

export async function submitBugReport(data: { description: string; email?: string; image?: string; hcaptcha_token: string }) {
  try {
    const res = await fetch(`${API}/api/bug-reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Erro desconhecido' }));
      throw new Error(err.detail || 'Erro ao enviar');
    }
    return res.json();
  } catch (err: any) {
    throw new Error(err.message || 'submitBugReport failed');
  }
}

export async function fetchGrupoValues() {
  try {
    const res = await fetch(`${API}/api/grupo-values`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    throw new Error(`fetchGrupoValues failed: ${err.message}`);
  }
}

export async function fetchHeatmapStates(p: any = {}, signal?: AbortSignal) {
  const params = new URLSearchParams();
  Object.entries(p).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(val => params.append(k, String(val)));
    else if (v !== undefined && v !== null) params.set(k, String(v));
  });
  try {
    const res = await fetch(`${API}/api/heatmap/states?${params}`, { signal });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    if (err.name === 'AbortError') return [];
    throw new Error(`fetchHeatmapStates failed: ${err.message}`);
  }
}

export async function fetchStateStats(p: any = {}) {
  const params = new URLSearchParams();
  Object.entries(p).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(val => params.append(k, String(val)));
    else if (v !== undefined && v !== null) params.set(k, String(v));
  });
  try {
    const res = await fetch(`${API}/api/state-stats?${params}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    throw new Error(`fetchStateStats failed: ${err.message}`);
  }
}

export async function fetchFilterOptions(p: any = {}) {
  const params = new URLSearchParams();
  Object.entries(p).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(val => params.append(k, String(val)));
    else if (v !== undefined && v !== null) params.set(k, String(v));
  });
  try {
    const res = await fetch(`${API}/api/filter-options?${params}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    throw new Error(`fetchFilterOptions failed: ${err.message}`);
  }
}

export async function fetchAvailableStates() {
  try {
    const res = await fetch(`${API}/api/available-states`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    throw new Error(`fetchAvailableStates failed: ${err.message}`);
  }
}

export async function fetchStateFilterInfo(selectedStates: string[]) {
  const params = new URLSearchParams();
  selectedStates.forEach(s => params.append('selected_states', s));
  try {
    const res = await fetch(`${API}/api/state-filter-info?${params}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    throw new Error(`fetchStateFilterInfo failed: ${err.message}`);
  }
}

export async function fetchDataAvailability(p: any = {}) {
  const params = new URLSearchParams();
  Object.entries(p).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(val => params.append(k, String(val)));
    else if (v !== undefined && v !== null) params.set(k, String(v));
  });
  try {
    const res = await fetch(`${API}/api/data-availability?${params}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    throw new Error(`fetchDataAvailability failed: ${err.message}`);
  }
}

export async function fetchSystemInfo() {
  try {
    const res = await fetch(`${API}/api/system-info`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  } catch (err: any) {
    throw new Error(`fetchSystemInfo failed: ${err.message}`);
  }
}
