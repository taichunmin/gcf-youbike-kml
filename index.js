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

exports.stationToKml = ({ name, stations }) => {
  const doc = { name }

  // stations
  doc.Placemark = _.map(stations, s => ({
    name: s.name,
    description: `地址: ${s.city}${s.area}${s.address}\n車位: ${s.space}`,
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

exports.cron = async () => {
  try {
    const kmls = []
    const stationsByType = _.groupBy(await exports.getCsv(CSV_YOUBIKE_STATIONS), 'type')
    const today = dayjs().utcOffset(8).format('YYYY-MM-DD')
    const promises = []
    _.each(stationsByType, (stations, type) => {
      promises.push(..._.map(_.chunk(stations, 2000), async (chunk, part) => {
        part = _.parseInt(part) + 1
        const kml = exports.stationToKml({ name: `YouBike ${type}.0 (${today} 第 ${part} 部份)`, stations })
        await exports.gcsUpload({
          contentType: 'application/vnd.google-earth.kml+xml; charset=utf-8',
          data: kml,
          dest: `youbike-kml/yb${type}-${part}.kml`,
        })
        kmls.push(`https://storage-taichunmin.taichunmin.idv.tw/youbike-kml/yb${type}-${part}.kml`)
      }))
    })
    await Promise.all(promises)
    await exports.gcsUpload({
      contentType: 'application/json; charset=utf-8',
      data: JSON.stringify(kmls),
      dest: 'youbike-kml/index.json',
    })
  } catch (err) {
    exports.log('ERROR', err)
  }
}
