const https = require('https');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  try {
    var body_parsed = req.body || {};
    var token = body_parsed.token;
    var dbid  = (body_parsed.dbid || '').replace(/-/g, '');

    if (!token || !dbid) {
      return res.status(400).json({ message: 'Token y Database ID requeridos.' });
    }

    // ---- Notion query (paginated) ----
    function queryNotion(cursor) {
      var payload = { page_size: 100 };
      if (cursor) payload.start_cursor = cursor;
      var body = JSON.stringify(payload);
      var options = {
        hostname: 'api.notion.com',
        path: '/v1/databases/' + dbid + '/query',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };
      return new Promise(function(resolve, reject) {
        var req2 = https.request(options, function(response) {
          var raw = '';
          response.on('data', function(c) { raw += c; });
          response.on('end', function() {
            try { resolve({ status: response.statusCode, body: JSON.parse(raw) }); }
            catch(e) { reject(e); }
          });
        });
        req2.on('error', reject);
        req2.write(body);
        req2.end();
      });
    }

    var results = [];
    var cursor = undefined;
    // Follow Notion pagination so bases with >100 rows still aggregate fully.
    for (var guard = 0; guard < 20; guard++) {
      var page = await queryNotion(cursor);
      if (page.status !== 200) {
        return res.status(page.status).json({ message: (page.body && page.body.message) || 'Error Notion.' });
      }
      results = results.concat(page.body.results || []);
      if (page.body.has_more && page.body.next_cursor) { cursor = page.body.next_cursor; }
      else break;
    }

    // ---------- helpers ----------
    function getProp(props) {
      var names = Array.prototype.slice.call(arguments, 1);
      for (var i = 0; i < names.length; i++) {
        var k = names[i].toLowerCase();
        var found = Object.keys(props).find(function(p) { return p.toLowerCase() === k; });
        if (found) return props[found];
      }
      return null;
    }

    function getSelectClean(prop) {
      if (!prop) return '';
      var name = '';
      if (prop.status && prop.status.name) name = prop.status.name;
      else if (prop.select && prop.select.name) name = prop.select.name;
      return name.replace(/[^\p{L}\s]/gu, '').trim().toLowerCase();
    }

    function getSelectFull(prop) {
      if (!prop) return '';
      if (prop.status && prop.status.name) return prop.status.name;
      if (prop.select && prop.select.name) return prop.select.name;
      return '';
    }

    function multiSelectFirst(prop, fallback) {
      if (!prop) return fallback || 'Sin valor';
      if (prop.multi_select && prop.multi_select.length > 0) return prop.multi_select[0].name;
      if (prop.select && prop.select.name) return prop.select.name;
      return fallback || 'Sin valor';
    }

    function getText(prop) {
      if (!prop) return '';
      if (prop.title && prop.title.length > 0) return prop.title[0].plain_text;
      if (prop.rich_text && prop.rich_text.length > 0) return prop.rich_text[0].plain_text;
      return '';
    }

    var CURRENCY_SYMBOLS = {
      'usd': '$', 'gtq': 'Q', 'mxn': 'MX$',
      'eur': '€', 'cop': 'COP$', 'pen': 'S/',
      'clp': 'CLP$', 'ars': 'AR$'
    };

    var ETIQ_PRIO = { 'Renovado': 3, 'Activo': 2, 'Finalizado': 1 };

    var MESES_ORDEN = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio',
                       'Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    function normMes(raw) {
      var t = (raw || '').trim();
      if (!t) return 'Sin mes';
      var low = t.toLowerCase();
      for (var i = 0; i < MESES_ORDEN.length; i++) {
        if (MESES_ORDEN[i].toLowerCase() === low) return MESES_ORDEN[i];
      }
      return t; // keep unexpected values as-is; sorted last
    }
    function mesIndex(m) {
      var idx = MESES_ORDEN.indexOf(m);
      return idx === -1 ? 99 : idx;
    }

    var monedaGlobal = '$';

    // ---------- normalize every record once ----------
    var records = results.map(function(page) {
      var props = page.properties || {};

      var presProp    = getProp(props, 'Presupuesto', 'PRESUPUESTO', 'Monto', 'MONTO');
      var presupuesto = (presProp && typeof presProp.number === 'number') ? presProp.number : 0;

      var monedaProp = getProp(props, 'Moneda', 'MONEDA', 'Currency');
      var moneda     = monedaProp ? multiSelectFirst(monedaProp, 'USD') : 'USD';
      var simbolo    = CURRENCY_SYMBOLS[moneda.toLowerCase()] || moneda + ' ';
      if (simbolo !== '$') monedaGlobal = simbolo;

      var stProp = getProp(props, 'Status', 'STATUS');
      var stClean = getSelectClean(stProp);
      var stFull  = getSelectFull(stProp) || 'Sin status';

      var esActivo     = stClean.indexOf('activo')     !== -1;
      var esRenovado   = stClean.indexOf('renovado')   !== -1;
      var esFinalizado = stClean.indexOf('finalizado') !== -1 || stClean.indexOf('cerrado') !== -1;
      var esRelevante  = esActivo || esRenovado || esFinalizado;

      var marcaProp = getProp(props, 'Marca/Clientes', 'Marca', 'MARCA/CLIENTES', 'MARCA');
      var cliente = 'Sin nombre';
      if (marcaProp && marcaProp.title && marcaProp.title.length > 0) {
        cliente = marcaProp.title[0].plain_text;
      }

      var campProp = getProp(props, 'Campaña', 'CAMPAÑA', 'Campana', 'CAMPANA');
      var campana  = getText(campProp) || cliente;

      var mesProp = getProp(props, 'Mes', 'MES');
      var mesNombre = normMes(getSelectFull(mesProp) || multiSelectFirst(mesProp, ''));

      var indProp   = getProp(props, 'Industria/Servicios', 'Industria', 'INDUSTRIA/SERVICIOS', 'INDUSTRIA');
      var industria = multiSelectFirst(indProp, 'Sin industria');

      var tipoProp   = getProp(props, 'Tipo', 'TIPO');
      var tipoNombre = multiSelectFirst(tipoProp, 'Sin tipo');

      var pagadoProp = getProp(props, 'Pagado', 'PAGADO');
      var isPagado   = pagadoProp && pagadoProp.checkbox === true;

      return {
        cliente: cliente,
        campana: campana,
        mes: mesNombre,
        presupuesto: presupuesto,
        simbolo: simbolo,
        stFull: stFull,
        esActivo: esActivo,
        esRenovado: esRenovado,
        esFinalizado: esFinalizado,
        esRelevante: esRelevante,
        industria: industria,
        tipo: tipoNombre,
        isPagado: isPagado,
        etiqueta: esRenovado ? 'Renovado' : esActivo ? 'Activo' : esFinalizado ? 'Finalizado' : ''
      };
    });

    // ---------- aggregate bundle for any subset of records ----------
    function sortMap(obj) {
      return Object.entries(obj)
        .sort(function(a, b) { return b[1] - a[1]; })
        .map(function(e) { return { nombre: e[0], total: e[1] }; });
    }

    function computeBundle(recs) {
      var totalPagado = 0, totalPorCobrar = 0;
      var byIndustria = {}, byClienteMap = {}, byClienteEtiq = {}, byClienteSimb = {};
      var byStatus = {}, byTipo = {};
      var marcasContadas = {}, marcasActivas = 0, marcasRenovadas = 0, marcasFinalizado = 0;
      var campanas = [];

      recs.forEach(function(r) {
        // Status donut counts every record (Prospecto, Contactado, etc.)
        byStatus[r.stFull] = (byStatus[r.stFull] || 0) + 1;
        if (!r.esRelevante) return;

        // unique brand counting with priority (Renovado > Activo > Finalizado)
        var etiqNueva = r.etiqueta;
        var etiqActual = marcasContadas[r.cliente];
        if (!etiqActual) {
          marcasContadas[r.cliente] = etiqNueva;
          if (r.esActivo)     marcasActivas++;
          if (r.esRenovado)   marcasRenovadas++;
          if (r.esFinalizado) marcasFinalizado++;
        } else if ((ETIQ_PRIO[etiqNueva] || 0) > (ETIQ_PRIO[etiqActual] || 0)) {
          if (etiqActual === 'Activo')     marcasActivas--;
          if (etiqActual === 'Renovado')   marcasRenovadas--;
          if (etiqActual === 'Finalizado') marcasFinalizado--;
          marcasContadas[r.cliente] = etiqNueva;
          if (r.esRenovado)    marcasRenovadas++;
          else if (r.esActivo) marcasActivas++;
          else                 marcasFinalizado++;
        }

        byTipo[r.tipo] = (byTipo[r.tipo] || 0) + 1;

        if (r.presupuesto > 0) {
          if (r.isPagado) {
            totalPagado += r.presupuesto;
            byIndustria[r.industria] = (byIndustria[r.industria] || 0) + r.presupuesto;
            byClienteMap[r.cliente]  = (byClienteMap[r.cliente] || 0) + r.presupuesto;
            byClienteSimb[r.cliente] = r.simbolo;
            var eA = byClienteEtiq[r.cliente];
            if (!eA || (ETIQ_PRIO[etiqNueva] || 0) > (ETIQ_PRIO[eA] || 0)) {
              byClienteEtiq[r.cliente] = etiqNueva;
            }
          } else {
            totalPorCobrar += r.presupuesto;
          }
        }

        campanas.push({
          campana:  r.campana,
          marca:    r.cliente,
          mes:      r.mes,
          monto:    r.presupuesto,
          simbolo:  r.simbolo,
          status:   r.stFull,
          pagado:   r.isPagado,
          etiqueta: r.etiqueta
        });
      });

      // brands ranked by paid revenue, carrying label + currency
      var byCliente = sortMap(byClienteMap).map(function(c) {
        return {
          nombre:   c.nombre,
          total:    c.total,
          etiqueta: byClienteEtiq[c.nombre] || 'Activo',
          simbolo:  byClienteSimb[c.nombre] || '$'
        };
      });

      // campaigns sorted by amount desc so "Top campañas" is meaningful
      campanas.sort(function(a, b) { return b.monto - a.monto; });

      return {
        totalPagado:      totalPagado,
        totalPorCobrar:   totalPorCobrar,
        marcasActivas:    marcasActivas,
        marcasRenovadas:  marcasRenovadas,
        marcasFinalizado: marcasFinalizado,
        byIndustria:      sortMap(byIndustria),
        byCliente:        byCliente,
        byStatus:         sortMap(byStatus),
        byTipo:           sortMap(byTipo),
        campanas:         campanas
      };
    }

    // ---------- months present + per-month bundles ----------
    var mesesPresentes = [];
    records.forEach(function(r) {
      if (r.esRelevante && mesesPresentes.indexOf(r.mes) === -1) mesesPresentes.push(r.mes);
    });
    mesesPresentes.sort(function(a, b) { return mesIndex(a) - mesIndex(b); });

    var porMes = { 'Todos': computeBundle(records) };
    mesesPresentes.forEach(function(m) {
      porMes[m] = computeBundle(records.filter(function(r) { return r.mes === m; }));
    });

    // ---------- bar-chart series: cobrado + por cobrar per month ----------
    var ingresosPorMes = mesesPresentes.map(function(m) {
      var b = porMes[m];
      return { mes: m, cobrado: b.totalPagado, porCobrar: b.totalPorCobrar };
    });

    // ---------- current month label ----------
    var now = new Date();
    var mesNowRaw = now.toLocaleString('es-ES', { month: 'long' });
    var mesActual = normMes(mesNowRaw);

    var todos = porMes['Todos'];

    // Response: new structure + backward-compatible top-level ("Todos") fields.
    return res.status(200).json({
      simbolo:        monedaGlobal,
      mesActual:      mesActual,
      meses:          mesesPresentes,
      ingresosPorMes: ingresosPorMes,
      porMes:         porMes,
      totalMarcas:    results.length,

      // legacy top-level = acumulado (mismo comportamiento anterior)
      totalPagado:      todos.totalPagado,
      totalPorCobrar:   todos.totalPorCobrar,
      marcasActivas:    todos.marcasActivas,
      marcasRenovadas:  todos.marcasRenovadas,
      marcasFinalizado: todos.marcasFinalizado,
      byIndustria:      todos.byIndustria,
      byCliente:        todos.byCliente,
      byStatus:         todos.byStatus,
      byTipo:           todos.byTipo,
      campanas:         todos.campanas,
      mes:              mesActual + ' de ' + now.getFullYear()
    });

  } catch(e) {
    return res.status(500).json({ message: 'Error: ' + e.message });
  }
};
