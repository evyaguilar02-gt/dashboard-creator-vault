const https = require('https');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  try {
    var t1 = 'ntn_629521693258SQhq';
    var t2 = 'RRAgPBonAn6b7BCFNSL4gRssAlB7UV';
    var token = t1 + t2;
    var dbid = '36eea83ddf6d80538053e6c7ad476a0e';
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

    var totalPagado     = 0;
    var totalPorCobrar  = 0;
    var byIndustria     = {};
    var byCliente       = {};
    var byStatus        = {};
    var byTipo          = {};
    var marcasActivas   = 0;
    var marcasRenovadas = 0;

    results.forEach(function(page) {
      var props = page.properties;
      if (!props) return;

      var presProp    = getProp(props, 'Presupuesto', 'PRESUPUESTO');
      var presupuesto = (presProp && typeof presProp.number === 'number') ? presProp.number : 0;

      var stProp  = getProp(props, 'Status', 'STATUS');
      var stClean = getSelectClean(stProp);
      var stFull  = getSelectFull(stProp) || 'Sin status';

      var esActivo   = stClean.indexOf('activo')   !== -1;
      var esRenovado = stClean.indexOf('renovado') !== -1;

      if (esActivo)   marcasActivas++;
      if (esRenovado) marcasRenovadas++;

      byStatus[stFull] = (byStatus[stFull] || 0) + 1;

      var tipoProp   = getProp(props, 'Tipo', 'TIPO');
      var tipoNombre = multiSelectFirst(tipoProp, 'Sin tipo');
      byTipo[tipoNombre] = (byTipo[tipoNombre] || 0) + 1;

      var pagadoProp = getProp(props, 'Pagado', 'PAGADO');
      var isPagado   = pagadoProp && pagadoProp.checkbox === true;

      if ((esActivo || esRenovado) && presupuesto > 0) {
        if (isPagado) {
          totalPagado += presupuesto;

          var indProp   = getProp(props, 'Industria/Servicios', 'Industria', 'INDUSTRIA/SERVICIOS', 'INDUSTRIA');
          var industria = multiSelectFirst(indProp, 'Sin industria');
          byIndustria[industria] = (byIndustria[industria] || 0) + presupuesto;

          var marcaProp = getProp(props, 'Marca/Clientes', 'Marca', 'MARCA/CLIENTES', 'MARCA');
          var cliente   = 'Sin nombre';
          if (marcaProp && marcaProp.title && marcaProp.title.length > 0) {
            cliente = marcaProp.title[0].plain_text;
          }
          byCliente[cliente] = (byCliente[cliente] || 0) + presupuesto;

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

    var now = new Date();
    return res.status(200).json({
      totalPagado:     totalPagado,
      totalPorCobrar:  totalPorCobrar,
      marcasActivas:   marcasActivas,
      marcasRenovadas: marcasRenovadas,
      totalMarcas:     results.length,
      byIndustria:     sort(byIndustria),
      byCliente:       sort(byCliente),
      byStatus:        sort(byStatus),
      byTipo:          sort(byTipo),
      mes: now.toLocaleString('es-ES', { month: 'long', year: 'numeric' })
    });

  } catch(e) {
    return res.status(500).json({ message: 'Error: ' + e.message });
  }
};
