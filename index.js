const _ = require('lodash')
const axios = require('axios')
const dayjs = require('dayjs')
const Papa = require('papaparse')
const xmlbuilder2 = require('xmlbuilder2')

// dayjs
dayjs.extend(require('dayjs/plugin/utc'))

exports.getenv = (key, defaultval) => _.get(process, ['env', key], defaultval)

const CSV_YOUBIKE_STATIONS = 'https://gcs-youbike2-linebot.taichunmin.idv.tw/latest-data/youbike-station.csv'

exports.errToPlainObj = (() => {
  const ERROR_KEYS = [
    'address',
    'code',
    'data',
    'dest',
    'errno',
    'info',
    'message',
    'name',
    'path',
    'port',
    'reason',
    'response.data',
    'response.headers',
    'response.status',
    'stack',
    'status',
    'statusCode',
    'statusMessage',
    'syscall',
  ]
  return err => _.pick(err, ERROR_KEYS)
})()

exports.log = (() => {
  const LOG_SEVERITY = ['DEFAULT', 'DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY']
  return (...args) => {
    let severity = 'DEFAULT'
    if (args.length > 1 && _.includes(LOG_SEVERITY, _.toUpper(args[0]))) severity = _.toUpper(args.shift())
    _.each(args, arg => {
      if (_.isString(arg)) arg = { message: arg }
      if (arg instanceof Error) arg = exports.errToPlainObj(arg)
      console.log(JSON.stringify({ severity, ...arg }))
    })
  }
})()

exports.getCsv = async url => {
  const csv = _.trim(_.get(await axios.get(url, {
    params: { cachebust: Date.now() },
  }), 'data'))
  return _.get(Papa.parse(csv, {
    encoding: 'utf8',
    header: true,
  }), 'data', [])
}

exports.gcsUpload = (() => {
  const GCS_BUCKET = exports.getenv('GCS_BUCKET')
  if (!GCS_BUCKET) return () => { throw new Error('GCS_BUCKET is required') }

  const { Storage } = require('@google-cloud/storage')
  const storage = new Storage()
  const bucket = storage.bucket(GCS_BUCKET)
  return async ({ dest, data, contentType = 'text/csv; charset=utf-8', maxAge = 30 }) => {
    const file = bucket.file(dest)
    await file.save(data, {
      gzip: true,
      // public: true,
      validation: 'crc32c',
      metadata: {
        cacheControl: `public, max-age=${maxAge}`,
        contentLanguage: 'zh',
        contentType,
      },
    })
  }
})()

exports.stationToKml = (() => {
  const kmlIcons = [
    {
      '@id': 'icon-yb1',
      IconStyle: {
        scale: '0.5',
        Icon: { href: 'https://i.imgur.com/WcdI4Nt.png' },
      },
    },
    {
      '@id': 'icon-yb2',
      IconStyle: {
        scale: '0.5',
        Icon: { href: 'https://i.imgur.com/cvcGgeu.png' },
      },
    },
  ]
  const typeStyle = { 1: '#icon-yb1', 2: '#icon-yb2' }

  return async ({ name, stations, today }) => {
    const doc = { name: `${name} (${today} 更新)` }

    // icons
    doc.Style = kmlIcons

    // stations
    doc.Placemark = _.map(stations, s => ({
      name: s.name,
      description: `地址: ${s.city}${s.area}${s.address}\n車位: ${s.space}`,
      styleUrl: typeStyle[s.type],
      Point: { coordinates: `${_.round(s.lng, 6)},${_.round(s.lat, 6)},0` },
    }))

    return xmlbuilder2.create({
      encoding: 'UTF-8',
      version: '1.0',
    }, {
      kml: {
        '@xmlns': 'http://www.opengis.net/kml/2.2',
        Document: doc,
      },
    }).end({ prettyPrint: false })
  }
})()

exports.kmlsToHtml = async ({ kmls, today }) => {
  return xmlbuilder2.create({
    encoding: 'UTF-8',
    version: '1.0',
  }, {
    kml: {
      '@xmlns': 'http://www.opengis.net/kml/2.2',
      Document: {
        name: 'YouBike 站點地圖',
        description: '台灣 YouBike 站點地圖，資料來自開放資料。',
        NetworkLink: _.map(kmls, (kml, part) => {
          part = _.parseInt(part) + 1
          return { name: `YouBike ${part}`, Link: { href: kml } }
        }),
      },
    },
  }).end({ prettyPrint: true })
}

exports.cron = async () => {
  try {
    const kmls = []
    const chunks = _.chunk(await exports.getCsv(CSV_YOUBIKE_STATIONS), 2000)
    const today = dayjs().utcOffset(8).format('YYYY-MM-DD')
    await Promise.all(_.map(chunks, async (stations, part) => {
      part = _.parseInt(part) + 1
      const kml = await exports.stationToKml({ name: `YouBike ${part}`, stations, today })
      await exports.gcsUpload({
        contentType: 'application/vnd.google-earth.kml+xml; charset=utf-8',
        data: kml,
        dest: `youbike-kml/${part}.kml`,
      })
      kmls.push(`https://storage-taichunmin.taichunmin.idv.tw/youbike-kml/${part}.kml`)
    }))
    // network links
    await exports.gcsUpload({
      contentType: 'application/json; charset=utf-8',
      data: JSON.stringify(kmls),
      dest: 'youbike-kml/index.json',
    })
  } catch (err) {
    exports.log('ERROR', err)
  }
}
