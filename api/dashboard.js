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

    var body  = JSON.stringify({ page_size: 100 });

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

    var data = await new Promise(function(resolve, reject) {
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

    if (data.status !== 200) {
      return res.status(data.status).json({ message: data.body.message || 'Error Notion.' });
    }

    var results = data.body.results || [];

    function getProp(props) {
      var names = Array.prototype.slice.call(arguments, 1);
      for (var i = 0; i < names.length; i++) {
        var k = names[i].toLowerCase();
        var found = Object.keys(props).find(function(p) {
          return p.toLowerCase() === k;
        });
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

    var CURRENCY_SYMBOLS = {
      'usd': '$', 'gtq': 'Q', 'mxn': 'MX$',
      'eur': '€', 'cop': 'COP$', 'pen': 'S/',
      'clp': 'CLP$', 'ars': 'AR$'
    };

    // Prioridad de etiqueta: Renovado > Activo > Finalizado
    var ETIQ_PRIO = { 'Renovado': 3, 'Activo': 2, 'Finalizado': 1 };

    var totalPagado      = 0;
    var totalPorCobrar   = 0;
    var byIndustria      = {};
    var byClienteMap     = {};
    var byClienteEtiq    = {};
    var byClienteSimb    = {};
    var byStatus         = {};
    var byTipo           = {};
    var marcasContadas   = {};
    var marcasActivas    = 0;
    var marcasRenovadas  = 0;
    var marcasFinalizado = 0;
    var monedaGlobal     = '$';

    results.forEach(function(page) {
      var props = page.properties;
      if (!props) return;

      var presProp    = getProp(props, 'Presupuesto', 'PRESUPUESTO', 'Monto', 'MONTO');
      var presupuesto = (presProp && typeof presProp.number === 'number') ? presProp.number : 0;

      var monedaProp = getProp(props, 'Moneda', 'MONEDA', 'Currency');
      var moneda     = monedaProp ? multiSelectFirst(monedaProp, 'USD') : 'USD';
      var simbolo    = CURRENCY_SYMBOLS[moneda.toLowerCase()] || moneda + ' ';
      if (simbolo !== '$') monedaGlobal = simbolo;

      var stProp   = getProp(props, 'Status', 'STATUS');
      var stClean  = getSelectClean(stProp);
      var stFull   = getSelectFull(stProp) || 'Sin status';

      var esActivo     = stClean.indexOf('activo')     !== -1;
      var esRenovado   = stClean.indexOf('renovado')   !== -1;
      var esFinalizado = stClean.indexOf('finalizado') !== -1 ||
                         stClean.indexOf('cerrado')    !== -1;

      byStatus[stFull] = (byStatus[stFull] || 0) + 1;

      // Nombre de marca para contar únicas
      var marcaProp = getProp(props, 'Marca/Clientes', 'Marca', 'MARCA/CLIENTES', 'MARCA');
      var cliente   = 'Sin nombre';
      if (marcaProp && marcaProp.title && marcaProp.title.length > 0) {
        cliente = marcaProp.title[0].plain_text;
      }

      // Contar marca única por status de mayor prioridad
      if (esActivo || esRenovado || esFinalizado) {
        var etiqNueva = esRenovado ? 'Renovado' : esActivo ? 'Activo' : 'Finalizado';
        var etiqActual = marcasContadas[cliente];
        if (!etiqActual) {
          marcasContadas[cliente] = etiqNueva;
          if (esActivo)     marcasActivas++;
          if (esRenovado)   marcasRenovadas++;
          if (esFinalizado) marcasFinalizado++;
        } else if ((ETIQ_PRIO[etiqNueva] || 0) > (ETIQ_PRIO[etiqActual] || 0)) {
          // Actualizar a status de mayor prioridad
          if (etiqActual === 'Activo')     marcasActivas--;
          if (etiqActual === 'Renovado')   marcasRenovadas--;
          if (etiqActual === 'Finalizado') marcasFinalizado--;
          marcasContadas[cliente] = etiqNueva;
          if (esRenovado)   marcasRenovadas++;
          else if (esActivo) marcasActivas++;
          else               marcasFinalizado++;
        }
      }

      // Tipo — solo activo, renovado o finalizado
      var tipoProp   = getProp(props, 'Tipo', 'TIPO');
      var tipoNombre = multiSelectFirst(tipoProp, 'Sin tipo');
      if (esActivo || esRenovado || esFinalizado) {
        byTipo[tipoNombre] = (byTipo[tipoNombre] || 0) + 1;
      }

      var pagadoProp = getProp(props, 'Pagado', 'PAGADO');
      var isPagado   = pagadoProp && pagadoProp.checkbox === true;

      if ((esActivo || esRenovado || esFinalizado) && presupuesto > 0) {
        if (isPagado) {
          totalPagado += presupuesto;

          var indProp   = getProp(props, 'Industria/Servicios', 'Industria', 'INDUSTRIA/SERVICIOS', 'INDUSTRIA');
          var industria = multiSelectFirst(indProp, 'Sin industria');
          byIndustria[industria] = (byIndustria[industria] || 0) + presupuesto;

          byClienteMap[cliente] = (byClienteMap[cliente] || 0) + presupuesto;
          byClienteSimb[cliente] = simbolo;

          // Etiqueta de mayor prioridad para el cliente
          var eActual = byClienteEtiq[cliente];
          var eNueva  = esRenovado ? 'Renovado' : esActivo ? 'Activo' : 'Finalizado';
          if (!eActual || (ETIQ_PRIO[eNueva] || 0) > (ETIQ_PRIO[eActual] || 0)) {
            byClienteEtiq[cliente] = eNueva;
          }

        } else {
          totalPorCobrar += presupuesto;
        }
      }
    });

    var sort = function(obj) {
      return Object.entries(obj)
        .sort(function(a, b) { return b[1] - a[1]; })
        .map(function(e) { return { nombre: e[0], total: e[1] }; });
    };

    var byCliente = sort(byClienteMap).map(function(c) {
      return {
        nombre:   c.nombre,
        total:    c.total,
        etiqueta: byClienteEtiq[c.nombre] || 'Activo',
        simbolo:  byClienteSimb[c.nombre] || '$'
      };
    });

    var now = new Date();
    var mes = now.toLocaleString('es-ES', { month: 'long' });
    mes = mes.charAt(0).toUpperCase() + mes.slice(1);

    return res.status(200).json({
      totalPagado:      totalPagado,
      totalPorCobrar:   totalPorCobrar,
      marcasActivas:    marcasActivas,
      marcasRenovadas:  marcasRenovadas,
      marcasFinalizado: marcasFinalizado,
      totalMarcas:      results.length,
      simbolo:          monedaGlobal,
      byIndustria:      sort(byIndustria),
      byCliente:        byCliente,
      byStatus:         sort(byStatus),
      byTipo:           sort(byTipo),
      mes:              mes + ' ' + now.getFullYear()
    });

  } catch(e) {
    return res.status(500).json({ message: 'Error: ' + e.message });
  }
};
