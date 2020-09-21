import {ConsoleSpanExporter, SimpleSpanProcessor, BatchSpanProcessor} from '@opentelemetry/tracing';
import {WebTracerProvider} from '@opentelemetry/web';
import {LogLevel} from '@opentelemetry/core';
import {SplunkDocumentLoad} from './docload';
import {SplunkXhrPlugin, SplunkFetchPlugin} from './xhrfetch';
import {SplunkUserInteractionPlugin} from './interaction';
import {PatchedZipkinExporter} from './zipkin';
import {captureErrors} from './errors';
import {findCookieValue, generateId} from './utils';
import {version as SplunkRumVersion} from '../package.json';
import {WebSocketInstrumentation} from './websocket';

if (!window.SplunkRum) {
  window.SplunkRum = {
    inited: false
  };

  window.SplunkRum.init = function (options) {
    // Check more frequently in the case of SPA/long-lived document
    const SessionTimeoutSeconds = 24 * 60 * 60;
    const SessionTimeoutCheckSeconds = 60 * 60;

    if (this.inited) {
      console.log('SplunkRum already init()ed.');
      return;
    }
    if (!options.debug) {
      if (!options.beaconUrl) {
        throw new Error('SplunkRum.init( {beaconUrl: \'https://something\'} ) is required.');
      }
      if (!options.rumAuth) {
        console.log('rumAuth will be required in the future');
      }
    }
    const app = options.app || 'unknown-browser-app';

    const instanceId = generateId(64);

    const cookieName = '_splunk_rum_sid';

    let rumSessionId = undefined;
    const cookieSetter = function() {
      if (!document.cookie.includes(cookieName)) {
        const sessionId = generateId(128);
        document.cookie = cookieName + '=' + sessionId + '; path=/; max-age=' + SessionTimeoutSeconds ;
        setTimeout(cookieSetter, 1000*SessionTimeoutCheckSeconds);
      }
      rumSessionId = findCookieValue(cookieName);
    };
    cookieSetter();

    let globalAttributes = options.globalAttributes && typeof options.globalAttributes === 'object' ? options.globalAttributes : undefined;
    this.setGlobalAttributes = function(attributes) {
      globalAttributes = typeof attributes === 'object' ? attributes : undefined;
    };

    // FIXME this is still not the cleanest way to add an attribute to all created spans..,
    class PatchedWTP extends WebTracerProvider {
      getTracer(name, version, config) {
        const tracer = super.getTracer(name, version, config);
        const origStartSpan = tracer.startSpan;
        tracer.startSpan = function () {
          const span = origStartSpan.apply(tracer, arguments);
          span.setAttribute('location.href', location.href);
          // FIXME does otel want this stuff in Resource?
          span.setAttribute('splunk.rumSessionId', rumSessionId);
          span.setAttribute('splunk.rumVersion', SplunkRumVersion);
          span.setAttribute('app', app);
          span.setAttribute('splunk.scriptInstance', instanceId);
          if (globalAttributes) {
            span.setAttributes(globalAttributes);
          }
          return span;
        };
        return tracer;
      }
    }

    const provider = new PatchedWTP({
      plugins: [
        new SplunkDocumentLoad(),
        new SplunkXhrPlugin(),
        new SplunkFetchPlugin(),
        new SplunkUserInteractionPlugin(),
      ],
      logLevel: options.debug ? LogLevel.DEBUG : LogLevel.ERROR,
    });
    new WebSocketInstrumentation(provider).patch();
    if (options.beaconUrl) {
      const completeUrl = options.beaconUrl + (options.rumAuth ? '?auth='+options.rumAuth : '');
      const batchSpanProcessor = new BatchSpanProcessor(new PatchedZipkinExporter(completeUrl), {
        bufferTimeout: 100, //millis, tradeoff between batching and loss of spans by not sending before page close
        bufferSize: 20, // spans, traceoff between batching and hitting sendBeacon invididual limits
      });
      window.addEventListener('beforeunload', function() {
        batchSpanProcessor.forceFlush();
      });
      provider.addSpanProcessor(batchSpanProcessor);
    }
    if (options.debug) {
      provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
    }
    provider.register();
    Object.defineProperty(this, '_provider', {value:provider});
    if (options.captureErrors === undefined || options.captureErrors === true) {
      captureErrors(this, provider); // also registers SplunkRum.error
    } else {
      // stub out error reporting method to not break apps that call it
      this.error = function() { };
    }
    this.inited = true;
    console.log('SplunkRum.init() complete');
  };
}
