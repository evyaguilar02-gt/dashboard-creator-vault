const https = require('https');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  var token = (req.body && req.body.token) || req.query.token;
  var dbid = (req.body && req.body.dbid) || req.query.dbid;

  if (!token || !dbid) return res.status(400).json({ message: 'Token y database ID requeridos.' });

  dbid = dbid.replace(/-/g, '');

  try {
    var body = JSON.stringify({ page_size: 100 });

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
      var request = https.request(options, function(response) {
        var rawData = '';
        response.on('data', function(chunk) { rawData += chunk; });
        response.on('end', function() {
          try { resolve({ status: response.statusCode, body: JSON.parse(rawData) }); }
          catch(e) { reject(e); }
        });
      });
      request.on('error', reject);
      request.write(body);
      request.end();
    });

    if (data.status !== 200) {
      return res.status(data.status).json({ message: data.body.message || 'Error de Notion.' });
    }

    var results = data.body.results || [];

    function getProp(props, name) {
      var key = name.toLowerCase().trim();
      var found = Object.keys(props).find(function(k) {
        return k.toLowerCase().trim() === key;
      });
      return found ? props[found] : null;
    }

    function getStatusClean(prop) {
      if (!prop) return '';
      var name = '';
      if (prop.status && prop.status.name) name = prop.status.name;
      else if (prop.select && prop.select.name) name = prop.select.name;
      return name.replace(/[^\p{L}\s]/gu, '').trim().toLowerCase();
    }

    function getStatusFull(prop) {
      if (!prop) return '';
      if (prop.status && prop.status.name) return prop.status.name;
      if (prop.select && prop.select.name) return prop.select.name;
      return '';
    }

    function getMultiSelectFirst(prop) {
      if (!prop) return '';
      if (prop.multi_select && prop.multi_select.length > 0) return prop.multi_select[0].name;
      if (prop.select && prop.select.name) return prop.select.name;
      return '';
    }

    var totalPagado = 0;
    var totalPorCobrar = 0;
    var byIndustria = {};
    var byCliente = {};
    var byStatus = {};
    var byTipo = {};
    var marcasActivas = 0;
    var marcasRenovadas = 0;

    results.forEach(function(page) {
      var props = page.properties;
      if (!props) return;

      var presProp = getProp(props, 'presupuesto');
      var presupuesto = (presProp && typeof presProp.number === 'number') ? presProp.number : 0;

      var statusProp = getProp(props, 'status');
      var statusClean = getStatusClean(statusProp);
      var statusFull = getStatusFull(statusProp) || 'Sin status';
      var esActivo = statusClean.indexOf('activo') !== -1;
      var esRenovado = statusClean.indexOf('renovado') !== -1;
      if (esActivo) marcasActivas++;
      if (esRenovado) marcasRenovadas++;
      byStatus[statusFull] = (byStatus[statusFull] || 0) + 1;

      var tipoProp = getProp(props, 'tipo');
      var tipoFull = getMultiSelectFirst(tipoProp) || 'Sin tipo';
      byTipo[tipoFull] = (byTipo[tipoFull] || 0) + 1;

      var pagadoProp = getProp(props, 'pagado');
      var isPagado = pagadoProp && pagadoProp.checkbox === true;

      var esActivaORenovada = esActivo || esRenovado;

      if (esActivaORenovada && presupuesto > 0) {
        if (isPagado) {
          totalPagado += presupuesto;

          var indProp = getProp(props, 'industria');
          var industria = getMultiSelectFirst(indProp) || 'Sin industria';
          byIndustria[industria] = (byIndustria[industria] || 0) + presupuesto;

          var marcaProp = getProp(props, 'marca');
          var cliente = 'Sin nombre';
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
      totalPagado: totalPagado,
      totalPorCobrar: totalPorCobrar,
      marcasActivas: marcasActivas,
      marcasRenovadas: marcasRenovadas,
      totalMarcas: results.length,
      byIndustria: sort(byIndustria),
      byCliente: sort(byCliente),
      byStatus: sort(byStatus),
      byTipo: sort(byTipo),
      mes: now.toLocaleString('es-ES', { month: 'long', year: 'numeric' })
    });

  } catch(error) {
    return res.status(500).json({ message: 'Error: ' + error.message });
  }
};
