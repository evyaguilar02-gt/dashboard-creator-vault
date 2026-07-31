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

    var MONTH_ORDER = ['enero','febrero','marzo','abril','mayo','junio',
                       'julio','agosto','septiembre','octubre','noviembre','diciembre'];

    var now = new Date();
    var mesActualIdx = now.getMonth(); // 0-11
    var mesActualNombre = MONTH_ORDER[mesActualIdx];

    // Acumuladores globales (todos los meses)
    var totalPagadoAll     = 0;
    var totalPorCobrarAll  = 0;

    // Acumuladores mes actual
    var totalPagadoMes    = 0;
    var totalPorCobrarMes = 0;

    var byIndustriaAll  = {};
    var byIndustriaMes  = {};
    var byClienteMapAll = {};
    var byClienteMapMes = {};
    var byClienteEtiq   = {};
    var byClienteSimb   = {};
    var byStatusAll     = {};
    var byTipoAll       = {};
    var byTipoMes       = {};
    var marcasContadas  = {};
    var marcasActivas   = 0;
    var marcasRenovadas = 0;
    var marcasFinalizado = 0;
    var monedaGlobal    = '$';
    var campanas        = [];
    var mesesDisponibles = {};

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
      var esFinalizado = stClean.indexOf('finalizado') !== -1 || stClean.indexOf('cerrado') !== -1;
      var esRelevante  = esActivo || esRenovado || esFinalizado;

      byStatusAll[stFull] = (byStatusAll[stFull] || 0) + 1;

      // Nombre de marca
      var marcaProp = getProp(props, 'Marca/Clientes', 'Marca', 'MARCA/CLIENTES', 'MARCA');
      var cliente   = 'Sin nombre';
      if (marcaProp && marcaProp.title && marcaProp.title.length > 0) {
        cliente = marcaProp.title[0].plain_text;
      }

      // Nombre de campaña
      var campProp = getProp(props, 'Campaña', 'CAMPAÑA', 'Campana', 'CAMPANA', 'Campaign');
      var campana  = getText(campProp) || cliente;

      // Mes
      var mesProp  = getProp(props, 'Mes', 'MES', 'Month');
      var mesNombre = getSelectFull(mesProp) || multiSelectFirst(mesProp, '');
      var mesClean  = mesNombre.toLowerCase().trim();
      var mesIdx    = MONTH_ORDER.indexOf(mesClean);
      var esMesActual = mesIdx === mesActualIdx;

      if (mesNombre) mesesDisponibles[mesNombre] = mesIdx;

      var pagadoProp = getProp(props, 'Pagado', 'PAGADO');
      var isPagado   = pagadoProp && pagadoProp.checkbox === true;

      // Contar marcas únicas
      if (esRelevante) {
        var etiqNueva  = esRenovado ? 'Renovado' : esActivo ? 'Activo' : 'Finalizado';
        var etiqActual = marcasContadas[cliente];
        if (!etiqActual) {
          marcasContadas[cliente] = etiqNueva;
          if (esActivo)     marcasActivas++;
          if (esRenovado)   marcasRenovadas++;
          if (esFinalizado) marcasFinalizado++;
        } else if ((ETIQ_PRIO[etiqNueva] || 0) > (ETIQ_PRIO[etiqActual] || 0)) {
          if (etiqActual === 'Activo')     marcasActivas--;
          if (etiqActual === 'Renovado')   marcasRenovadas--;
          if (etiqActual === 'Finalizado') marcasFinalizado--;
          marcasContadas[cliente] = etiqNueva;
          if (esRenovado)    marcasRenovadas++;
          else if (esActivo) marcasActivas++;
          else               marcasFinalizado++;
        }

        // Tipo
        var tipoProp   = getProp(props, 'Tipo', 'TIPO');
        var tipoNombre = multiSelectFirst(tipoProp, 'Sin tipo');
        byTipoAll[tipoNombre] = (byTipoAll[tipoNombre] || 0) + 1;
        if (esMesActual) {
          byTipoMes[tipoNombre] = (byTipoMes[tipoNombre] || 0) + 1;
        }

        // Campaña para la tabla
        campanas.push({
          campana:  campana,
          marca:    cliente,
          mes:      mesNombre || 'Sin mes',
          monto:    presupuesto,
          simbolo:  simbolo,
          status:   stFull,
          pagado:   isPagado,
          etiqueta: etiqNueva
        });
      }

      if (esRelevante && presupuesto > 0) {
        var indProp   = getProp(props, 'Industria/Servicios', 'Industria', 'INDUSTRIA/SERVICIOS', 'INDUSTRIA');
        var industria = multiSelectFirst(indProp, 'Sin industria');

        if (isPagado) {
          totalPagadoAll += presupuesto;
          byIndustriaAll[industria] = (byIndustriaAll[industria] || 0) + presupuesto;
          byClienteMapAll[cliente]  = (byClienteMapAll[cliente] || 0) + presupuesto;
          byClienteSimb[cliente]    = simbolo;
          var eA = byClienteEtiq[cliente];
          var eN = esRenovado ? 'Renovado' : esActivo ? 'Activo' : 'Finalizado';
          if (!eA || (ETIQ_PRIO[eN] || 0) > (ETIQ_PRIO[eA] || 0)) {
            byClienteEtiq[cliente] = eN;
          }
          if (esMesActual) {
            totalPagadoMes += presupuesto;
            byIndustriaMes[industria]  = (byIndustriaMes[industria] || 0) + presupuesto;
            byClienteMapMes[cliente]   = (byClienteMapMes[cliente] || 0) + presupuesto;
          }
        } else {
          totalPorCobrarAll += presupuesto;
          if (esMesActual) totalPorCobrarMes += presupuesto;
        }
      }
    });

    var sort = function(obj) {
      return Object.entries(obj)
        .sort(function(a, b) { return b[1] - a[1]; })
        .map(function(e) { return { nombre: e[0], total: e[1] }; });
    };

    var buildClientes = function(map) {
      return sort(map).map(function(c) {
        return {
          nombre:   c.nombre,
          total:    c.total,
          etiqueta: byClienteEtiq[c.nombre] || 'Activo',
          simbolo:  byClienteSimb[c.nombre] || '$'
        };
      });
    };

    // Meses disponibles ordenados
    var mesesOrdenados = Object.keys(mesesDisponibles).sort(function(a, b) {
      return (mesesDisponibles[a] || 0) - (mesesDisponibles[b] || 0);
    });

    var mesActualStr = MONTH_ORDER[mesActualIdx];
    mesActualStr = mesActualStr.charAt(0).toUpperCase() + mesActualStr.slice(1);

    return res.status(200).json({
      // Mes actual
      totalPagadoMes:    totalPagadoMes,
      totalPorCobrarMes: totalPorCobrarMes,
      byIndustriaMes:    sort(byIndustriaMes),
      byClienteMes:      buildClientes(byClienteMapMes),
      byTipoMes:         sort(byTipoMes),
      // Acumulado total
      totalPagadoAll:    totalPagadoAll,
      totalPorCobrarAll: totalPorCobrarAll,
      byIndustriaAll:    sort(byIndustriaAll),
      byClienteAll:      buildClientes(byClienteMapAll),
      byTipoAll:         sort(byTipoAll),
      // Compartidos
      marcasActivas:     marcasActivas,
      marcasRenovadas:   marcasRenovadas,
      marcasFinalizado:  marcasFinalizado,
      totalMarcas:       results.length,
      simbolo:           monedaGlobal,
      byStatus:          sort(byStatusAll),
      campanas:          campanas,
      meses:             mesesOrdenados,
      mesActual:         mesActualStr + ' de ' + now.getFullYear()
    });

  } catch(e) {
    return res.status(500).json({ message: 'Error: ' + e.message });
  }
};
