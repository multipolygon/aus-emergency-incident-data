/* eslint-disable no-console */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import fetch from 'node-fetch';
import jsonschema from 'jsonschema';
import toGeoJSON from '@mapbox/togeojson';
import moment from 'moment-timezone';
import jsdom from 'jsdom';
import mkdirp from 'mkdirp';
import UserAgent from 'user-agents';

const targetPath = path.join('.', 'data');
const useCache = process.argv.includes('--cache');
const geoJsonSchema = JSON.parse(fs.readFileSync(path.join('.', 'schema.geo.json')));
const validator = new jsonschema.Validator();

const randomUserAgent = new UserAgent();

const sources = {
    vic: {
        type: 'geo.json',
        url: 'https://emergency.vic.gov.au/public/osom-geojson.json',
    },
    nsw: {
        type: 'geo.json',
        url: 'https://www.rfs.nsw.gov.au/feeds/majorIncidents.json',
    },
    wa: {
        type: 'geo.json',
        url: 'https://www.emergency.wa.gov.au/data/incident_FCAD.json',
    },
    wa_warn: {
        type: 'geo.json',
        url: 'https://www.emergency.wa.gov.au/data/message_warnings.json',
    },
    // sa_warn: {
    //     type: 'geo.json',
    //     headers: {
    //         Origin: 'https://apps.geohub.sa.gov.au',
    //     },
    //     url:
    //         'https://services.geohub.sa.gov.au/v1CFSHA/featurelayer/server/rest/services/Hosted/CFS_Warning_Points_Public/FeatureServer/0/query?f=geojson&where=public%20%3D%20%27true%27%20AND%20expiry%20%3E%20CURRENT_TIMESTAMP&returnGeometry=true&spatialRel=esriSpatialRelIntersects&outFields=*&outSR=4326&resultOffset=0&resultRecordCount=1000&geometryPrecision=6&maxAllowableOffset=20',
    // },
    // nt: {
    //     type: 'json',
    //     url: "https://www.pfes.nt.gov.au/incidentmap/json/ntfrsincidents.json",
    // },
    // nt_warn: {
    //     type: 'json',
    //     url: "https://www.pfes.nt.gov.au/incidentmap/json/warnings.json",
    // },
    sa_cfs: {
        type: 'kml',
        url: 'http://data.eso.sa.gov.au/prod/cfs/criimson/cfs_incident_placemark.xml',
    },
    sa_mfs: {
        type: 'kml',
        url: 'http://data.eso.sa.gov.au/prod/mfs/criimson/mfs_incident_placemark.xml',
    },
    tas: {
        type: 'kml',
        url: 'http://www.fire.tas.gov.au/Show?pageId=bfKml&t=26306052',
    },
    tas_warn: {
        type: 'kml',
        url: 'http://www.fire.tas.gov.au/Show?pageId=alertKml&t=26306052',
    },
    qld: {
        type: 'kmz',
        url: 'https://www.qfes.qld.gov.au/data/alerts/bushfireAlert.kmz',
    },
};

const download = (src, filePath) =>
    new Promise((resolve) => {
        console.log('Fetch:', src.url);
        fetch(src.url, {
            headers: {
                ...src.headers,
                'User-Agent': randomUserAgent().toString(),
            },
        })
            .then((response) => {
                const fileStream = fs.createWriteStream(filePath);
                response.body.pipe(fileStream);
                response.body.on('error', () => {
                    console.log(` > FAILED!`);
                    resolve(false);
                });
                fileStream.on('finish', () => {
                    console.log(` > OK`);
                    resolve(true);
                });
            })
            .catch(() => {
                console.log('>', 'ERROR!');
                resolve(null);
            });
    });

const validate = (obj) => {
    const result = validator.validate(obj, geoJsonSchema, { throwError: false });
    if (result.errors.length > 0) {
        console.log('Warning: Invalid GeoJSON!');
        result.errors.forEach((e) => console.log(' => ', e.stack));
        return false;
    }
    return true;
};

const parseHtmlData = (html, sep) => {
    return html.split(sep || '<br />').reduce(function(obj, line) {
        const pair = line.split(':');
        const k = pair
            .shift()
            .trim()
            .toLowerCase();
        obj[k] = pair.join(':').trim();
        return obj;
    }, {});
};

const parseTasDescription = (s) => {
    const re = '<th.*?>(.*?)</th><td.*?>(.*?)</td>';
    return s.match(new RegExp(re, 'g')).reduce(function(obj, m) {
        const e = m.match(new RegExp(re));
        if (e) {
            obj[e[1].toLowerCase()] = e[2];
        }
        return obj;
    }, {});
};

const mapFeedType = {
    incident: 'incident',
    warning: 'warning',
};

const mapCategory = {
    'accident / rescue': 'rescue',
    'burn off': 'fire',
    'planned burn': 'fire',
    'structure fire': 'fire',
    'storm - get ready': 'weather',
    'storm - take action now': 'weather',
    storm: 'weather',
    burnoff: 'fire',
    bushfire: 'fire',
};

const mapSubcategory = {
    'bush fire': 'bushfire',
    met: 'weather',
};

const lower = (str) => (typeof str === 'string' ? str.toLowerCase() : 'other');

const cleanProperties = ({ feedType, sourceTitle, category, subcategory, status, ...other }) => {
    const properties = {
        feedType: mapFeedType[lower(feedType)] || 'other',
        sourceTitle: sourceTitle || 'Untitled',
        category: mapCategory[lower(category)] || lower(category),
        subcategory: mapSubcategory[lower(subcategory)] || lower(subcategory),
        status: lower(status),
        ...other,
    };

    properties.title = `${properties.feedType}: ${properties.category}`;

    if (category === 'met') {
        properties.feedType = 'warning';
        properties.category1 = 'weather';
    }

    return properties;
};

const mapProperties = {
    vic: ({
        created,
        updated,
        id,
        sourceTitle,
        feedType,
        category1,
        category2,
        status,
        location,
        size,
        description,
    }) => ({
        created: moment.tz(created, moment.ISO_8601, 'Australia/Melbourne').format(),
        updated: moment.tz(updated, moment.ISO_8601, 'Australia/Melbourne').format(),
        id,
        sourceTitle,
        feedType,
        category: category1,
        subcategory: category2,
        status,
        location,
        size,
        description,
    }),
    nsw: ({ description, guid, title, pubDate }) => {
        const { updated, fire, type, status, location, size } = parseHtmlData(description);
        return {
            id: guid,
            sourceTitle: title,
            created: moment.tz(pubDate, 'D/MM/YYYY h:mm:ss A', 'Australia/Sydney').format(),
            updated: moment.tz(updated, 'D MMM YYYY HH:mm', 'Australia/Sydney').format(),
            feedType: 'incident',
            category: fire === 'Yes' ? 'fire' : 'other',
            subcategory: type,
            status,
            location,
            size: parseFloat(size || 0),
            description,
        };
    },
    wa: ({
        incidentEventsId,
        DFESUniqueNumber,
        messageId,
        locationSuburb,
        startTime,
        lastUpdatedTime,
        type,
        status,
        areaBurnt,
        description,
    }) => ({
        id: [incidentEventsId, DFESUniqueNumber, messageId].filter(Boolean).join('-'),
        sourceTitle: locationSuburb,
        created: moment.tz(startTime, 'YYYY-MM-DD HH:mm:ss', 'Australia/Perth').format(),
        updated: moment.tz(lastUpdatedTime, 'YYYY-MM-DD HH:mm:ss', 'Australia/Perth').format(),
        feedType: 'incident',
        category: type,
        subcategory: type,
        status,
        location: locationSuburb,
        size: areaBurnt,
        description,
    }),
    wa_warn: ({
        incidentEventsId,
        DFESUniqueNumber,
        messageId,
        fcadId,
        locationSuburb,
        startTime,
        lastUpdatedTime,
        type,
        status,
        areaBurnt,
        subject,
    }) => ({
        id: [incidentEventsId, DFESUniqueNumber, messageId, fcadId].filter(Boolean).join('-'),
        sourceTitle: locationSuburb,
        created: startTime,
        updated: moment.tz(lastUpdatedTime, 'DD-MM-YY hh:mm:ss a', 'Australia/Perth').format(),
        feedType: 'warning',
        category: type,
        subcategory: type,
        status,
        location: locationSuburb,
        size: areaBurnt,
        description: subject,
    }),
    /* eslint-disable camelcase */
    sa_warn: ({ incident_id, objectid, icon, last_edited_date }) => ({
        id: [incident_id, objectid].filter(Boolean).join('-'),
        sourceTitle: icon,
        updated: moment.tz(last_edited_date, 'x', 'Australia/Adelaide').format(),
        feedType: 'warning',
        category: icon,
        subcategory: 'other',
        status: 'other',
    }),
    /* eslint-enable camelcase */
    sa_cfs: ({ name, styleUrl, description }, id) => {
        const { 'first reported': firstReported, status } = parseHtmlData(description, '<br>');
        const created = moment
            .tz(firstReported, 'dddd DD MMM YYYY HH:mm:ss', 'Australia/Adelaide')
            .format();
        return {
            id,
            sourceTitle: name,
            created,
            updated: created,
            feedType: 'incident',
            category: styleUrl
                .replace('#', '')
                .replace('ClosedIcon', '')
                .replace('OpenIcon', '')
                .replace('SafeIcon', ''),
            subcategory: description.split('<br>', 1)[0],
            status,
        };
    },
    tas: ({ name, description }, id) => {
        const { 'last update': lastUpdate, type, status, size } = parseTasDescription(description);
        const created = moment.tz(lastUpdate, 'DD-MMM-YYYY hh:mm a', 'Australia/Hobart').format();
        return {
            id: id + name,
            sourceTitle: name,
            created,
            updated: created,
            feedType: 'incident',
            category: type.includes('FIRE') ? 'fire' : 'other',
            subcategory: type,
            status,
            size: parseFloat(size || 0),
        };
    },
    tas_warn: (props, id) => ({
        id,
        sourceTitle: 'No title',
        created: moment().format(),
        updated: moment().format(),
        feedType: 'other',
        category: 'other',
        subcategory: 'other',
        status: 'other',
    }),
    /* eslint-disable camelcase */
    qld: ({
        Master_Incident_Number,
        Location,
        ResponseDate,
        LastUpdate,
        IncidentType,
        CurrentStatus,
        Region,
        MediaMessage,
        VehiclesOnRoute,
        VehiclesOnScene,
    }) => ({
        id: Master_Incident_Number,
        sourceTitle: Location,
        created: moment.tz(ResponseDate, 'YYYYMMDDHHmmss', 'Australia/Brisbane').format(),
        updated: moment.tz(LastUpdate, 'YYYYMMDDHHmmss', 'Australia/Brisbane').format(),
        feedType: 'incident',
        category: 'other',
        subcategory: IncidentType,
        status: CurrentStatus,
        location: Region,
        description: MediaMessage,
        resources: parseInt(VehiclesOnRoute) + parseInt(VehiclesOnScene),
    }),
    /* eslint-enable camelcase */
};

mapProperties.sa_mfs = mapProperties.sa_cfs;

const convertGeoJson = (name, src, obj) => {
    try {
        validate(obj);
        const output = {
            type: 'FeatureCollection',
            features: obj.features.map((feature) => ({
                ...feature,
                properties: cleanProperties(mapProperties[name](feature.properties, feature.id)),
            })),
        };
        const filePath = path.join(targetPath, `${name}.geo.json`);
        fs.writeFileSync(filePath, JSON.stringify(output, null, 4));
    } catch (e) {
        console.log('Conversion error!');
        console.log(e);
    }
};

const convertKml = (name, src, content) => {
    const document = new jsdom.JSDOM(content.toString()).window.document;
    const obj = toGeoJSON.kml(document);
    const filePath = path.join(targetPath, 'orig', `${name}.geo.json`);
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 4));
    return convertGeoJson(name, src, obj);
};

const convertKmz = (name, src) => {
    const dirPath = path.join(targetPath, 'orig');
    exec(`cd ${dirPath} && unzip -o ${name}.kmz doc.kml`, (error, stdout, stderr) => {
        if (error || stderr) {
            console.log(error);
            console.log(stderr);
        } else {
            console.log(stdout);
            const filePath = path.join(dirPath, 'doc.kml');
            if (fs.existsSync(filePath)) {
                const kml = fs.readFileSync(filePath);
                convertKml(name, src, kml);
            }
        }
    });
};

const convertFunctions = {
    'geo.json': convertGeoJson,
    kml: convertKml,
    kmz: convertKmz,
};

const convert = (name, src, content) => {
    if (src.type in convertFunctions) {
        convertFunctions[src.type](name, src, content);
    } else {
        console.log('Unhandled type:', src.type);
    }
};

const run = async () => {
    for (const name in sources) {
        console.log(name);
        const src = sources[name];
        const dirPath = path.join(targetPath, 'orig');
        mkdirp.sync(dirPath);
        const filePath = path.join(dirPath, `${name}.${src.type}`);
        if (!useCache || !fs.existsSync(filePath)) {
            await download(src, filePath);
        }
        if (fs.existsSync(filePath)) {
            if (src.type === 'geo.json' || src.type === 'json' || src.type === 'kml') {
                console.log('Read File:', filePath);
                const content = fs.readFileSync(filePath);
                if (src.type === 'geo.json' || src.type === 'json') {
                    try {
                        convert(name, src, JSON.parse(content));
                    } catch (e) {
                        console.log('JSON parse error!');
                    }
                } else {
                    convert(name, src, content);
                }
            } else {
                convert(name, src, null);
            }
        }
    }
};

run().then(() => {});
