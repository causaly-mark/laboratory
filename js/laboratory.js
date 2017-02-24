class Lab {
  constructor() {
    this.defaultState = () => {
      return {
        config: {
          hosts: [],  // list of hosts to monitor
          strictness: {
            'connect-src': 'self-if-same-origin-else-path',
            'font-src': 'origin',
            'frame-src': 'origin',
            'img-src': 'origin',
            'media-src': 'origin',
            'object-src': 'path',
            'script-src': 'self-if-same-origin-else-path',
            'style-src': 'self-if-same-origin-else-directory',
          },
        },
        records: {},  // hosts -> sources mapping
      }
    };

    // hoist static functions or something
    this.extractHostname = Lab.extractHostname;
    this.unmonitorableSites = Lab.unmonitorableSites;
  }


  static extractHostname(url) {
    const a = document.createElement('a');
    a.href = url;
    return a.host;
  }


  static get strictnessDefs() {
    return {
      directory: 'Directory',
      origin: '\'self\' if same origin, otherwise origin',
      path: 'Full path to resource',
      'self-if-same-origin-else-directory': '\'self\' if same origin, otherwise directory',
      'self-if-same-origin-else-path': '\'self\' if same origin, otherwise full path',
    };
  }


  static get unmonitorableSites() {
    return [
      'addons.mozilla.org',
      'discovery.addons.mozilla.org',
      'testpilot.firefox.com',
    ];
  }


  siteTemplate() {
    const site = {};
    Object.keys(this.defaultState().config.strictness).map((x) => {
      site[x] = [];  // TODO: convert to Set once localforage supports it
    });

    return site;
  }


  init() {
    const hosts = this.state.config.hosts;
    let listener;

    // we don't need to add any listeners if we're not yet monitoring any hosts
    if (hosts === null) { return; }
    if (hosts.length === 0) { return; }

    // listen for all requests and inject a CSPRO header
    const urls = [];

    for (const host of hosts) {
      urls.push(`http://${host}/*`);
      urls.push(`https://${host}/*`);
    }

    // we create a listener here to inject CSPRO headers
    // we define it globally so that we don't have to keep recreating anonymous functions,
    // which has the side effect of making it much easier to remove the listener
    if (this.onHeadersReceivedListener === undefined) {
      this.onHeadersReceivedListener = (request) => this.injectCspReportOnlyHeader(request);
    } else {
      // delete the old listener
      browser.webRequest.onHeadersReceived.removeListener(this.onHeadersReceivedListener);
    }

    browser.webRequest.onHeadersReceived.addListener(
      this.onHeadersReceivedListener,
      { urls },
      ['blocking', 'responseHeaders']);
  }


  clearState() {
    console.log('Laboratory: Clearing all local storage', this.listeners);
    this.state = this.defaultState();
  }


  getLocalState() {
    return new Promise((resolve, reject) => {
      // if state already exists, we can just return that
      if (this.state !== undefined) {
        return resolve(this.state);
      }

      localforage.getItem('state').then((state) => {
        if (state === null) {
          return resolve(this.defaultState());
        }

        return resolve(state);
      });
    });
  }


  setState(state) {
    this.state = state;
  }


  writeLocalState() {
    return localforage.setItem('state', this.state);
  }


  ingestCspReport(request) {
    return new Promise((resolve, reject) => {
      const cancel = { cancel: true };
      const decoder = new TextDecoder('utf8');
      const records = this.state.records;

      // parse the CSP report
      const report = JSON.parse(decoder.decode(request.requestBody.raw[0].bytes))['csp-report'];
      const directive = report['violated-directive'].split(' ')[0];
      const host = Lab.extractHostname(report['document-uri']);
      let uri = report['blocked-uri'];

      // catch the special cases (data, unsafe)
      switch (uri) {
        case 'self':
          uri = '\'unsafe-inline\'';  // boo
          break;
        case 'data':
          uri = 'data:';
          break;
        default:
          break;
      }

      // add the host to the records, if it's not already there
      if (!(host in records)) {
        records[host] = this.siteTemplate();
      }

      // add the uri to the resources for that directive
      if (!(records[host][directive].includes(uri))) {
        records[host][directive].push(uri);
      }

      return resolve(cancel);
    });
  }


  injectCspReportOnlyHeader(request) {
    return new Promise((resolve, reject) => {
      // todo: remove an existing CSP
      let i = request.responseHeaders.length;
      while (i > 0) {
        i -= 1;
        if (['content-security-policy', 'content-security-policy-report-only'].includes(request.responseHeaders[i].name.toLowerCase())) {
          request.responseHeaders.splice(i, 1);
        }
      }

      // push a response header onto the stack to block all requests in report only mode
      request.responseHeaders.push({
        name: 'Content-Security-Policy-Report-Only',
        value: 'default-src \'none\'; connect-src \'none\'; font-src \'none\'; frame-src \'none\'; img-src \'none\'; media-src \'none\'; object-src \'none\'; script-src \'none\'; style-src \'none\'; report-uri /laboratory-fake-csp-report',
      });

      return resolve({ responseHeaders: request.responseHeaders });
    });
  }
}


console.log('Laboratory: Initializing');
const lab = new Lab();
lab.getLocalState().then(state => lab.setState(state)).then(() => {
  // expose state to the popup
  Object.assign(window, {
    Lab: lab,
  });

  // we don't add/remove the ingester, simply because if it was in the midst of being
  // toggled, it would send fake 404 requests to sites accidentally
  browser.webRequest.onBeforeRequest.addListener(
    (request) => lab.ingestCspReport(request),
    { urls: ['*://*/laboratory-fake-csp-report'] },
    ['blocking', 'requestBody']);

  lab.init();
});


/* Synchronize the local storage every time a page finishes loading */
browser.webNavigation.onCompleted.addListener(() => {
  lab.writeLocalState().then();
});
