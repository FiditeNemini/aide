/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import httpProxy from 'http-proxy';
import { parse, parseFragment, defaultTreeAdapter, serialize, } from 'parse5';
import * as zlib from 'zlib';

function cleanup(
	proxy: httpProxy<http.IncomingMessage, http.ServerResponse<http.IncomingMessage>>,
	server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>
) {
	proxy.removeAllListeners();
	server.removeAllListeners();
	try {
		server.close();
	} catch (e) {
		console.error(e);
	}
	try {
		proxy.close();
	} catch (e) {
		console.error(e);
	}
}

function pipeThrough(
	serverResponse: http.ServerResponse<http.IncomingMessage>,
	proxyResponse: http.IncomingMessage
) {
	serverResponse.writeHead(proxyResponse.statusCode || 200, proxyResponse.headers);
	proxyResponse.pipe(serverResponse);
}

const makeDevtoolsScript = (location: string) => `<script src="${location}"></script>`;

// TODO(@g-danna) import raw contents of file (and minify)
const makeNavigationScript = (nonce: string | null) => `<script ${nonce ? `nonce="${nonce}"` : ''}>
(function() {
// Save references to the original History API methods
const originalPushState = history.pushState;
const originalReplaceState = history.replaceState;

// Helper: dispatch a custom event on window
function triggerLocationChange() {
const event = new Event('locationchange');
window.dispatchEvent(event);
}

// Override pushState
history.pushState = function(...args) {
// Call original pushState
const returnValue = originalPushState.apply(this, args);
// Dispatch our custom event right after
triggerLocationChange();
return returnValue;
};

// Override replaceState
history.replaceState = function(...args) {
const returnValue = originalReplaceState.apply(this, args);
triggerLocationChange();
return returnValue;
};

// Handle back/forward navigation (popstate event)
window.addEventListener('popstate', () => {
triggerLocationChange();
});

// Optionally, handle hash changes (if relevant):
window.addEventListener('hashchange', () => {
triggerLocationChange();
});
})();

// Example usage:
window.addEventListener('locationchange', () => {
window.parent.postMessage({
type: 'location-change',
location: window.location.href
}, '*');
});
</script>`;

function startInterceptingDocument(
	proxy: httpProxy<http.IncomingMessage, http.ServerResponse<http.IncomingMessage>>,
	reactDevtoolsPort: number,
	// proxyPort: number,
) {
	proxy.on('proxyRes', (proxyRes, _req, res) => {
		const bodyChunks: Uint8Array[] = [];
		proxyRes.on('data', (chunk) => {
			bodyChunks.push(chunk);
		});
		proxyRes.on('end', () => {
			const contentType = proxyRes.headers['content-type'] || '';
			const isHtml = contentType.toLowerCase().includes('text/html');

			// If it's not HTML, just pipe it through
			if (!isHtml) {
				const buffer = Buffer.concat(bodyChunks);
				res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
				res.end(buffer);
				return;
			}

			// Handle potential compression
			const contentEncoding = (proxyRes.headers['content-encoding'] || '').toLowerCase();
			const rawBuffer = Buffer.concat(bodyChunks);
			let decompressedBuffer: Buffer;
			try {
				if (contentEncoding.includes('gzip')) {
					decompressedBuffer = zlib.gunzipSync(rawBuffer);
				} else if (contentEncoding.includes('deflate')) {
					decompressedBuffer = zlib.inflateSync(rawBuffer);
				} else if (contentEncoding.includes('br')) {
					decompressedBuffer = zlib.brotliDecompressSync(rawBuffer);
				} else {
					// No known compression
					decompressedBuffer = rawBuffer;
				}
			} catch (e) {
				console.error('Decompression error:', e);
				res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
				res.end(rawBuffer);
				return;
			}

			const originalBody = decompressedBuffer.toString('utf8');
			const document = parse(originalBody);
			const htmlNode = document.childNodes.find(node => node.nodeName === 'html');
			if (!htmlNode || !defaultTreeAdapter.isElementNode(htmlNode)) {
				console.log('No html node found');
				pipeThrough(res, proxyRes);
				return;
			}

			const headNode = htmlNode.childNodes.find(node => node.nodeName === 'head');
			if (!headNode || !defaultTreeAdapter.isElementNode(headNode)) {
				console.log('No head node found');
				pipeThrough(res, proxyRes);
				return;
			}

			// Conditionally inject the DevTools script if you actually have a server on that port:
			const devtoolsUrl = `http://localhost:${reactDevtoolsPort}`;
			// Optional: Check that reactDevtoolsPort is open before injecting, or remove if unneeded.
			const devtoolsScriptFragment = parseFragment(makeDevtoolsScript(devtoolsUrl));
			const devtoolsScriptNode = devtoolsScriptFragment.childNodes[0];

			defaultTreeAdapter.appendChild(headNode, devtoolsScriptNode);

			// Adjust headers
			const headers = { ...proxyRes.headers };
			let cspHeader = headers['content-security-policy'];
			if (Array.isArray(cspHeader)) {
				cspHeader = cspHeader.join('; ');
			}
			const nonce = cspHeader ? extractNonce(cspHeader) : null;

			const navigationScriptFragment = parseFragment(makeNavigationScript(nonce), { onParseError: (error) => console.log(error) });
			const navigationScriptNode = navigationScriptFragment.childNodes[0];

			defaultTreeAdapter.appendChild(headNode, navigationScriptNode);

			// Re-serialize the HTML
			const modifiedBody = serialize(document);






			if (typeof cspHeader === 'string') {
				cspHeader = cspHeader.replace(
					/frame-ancestors[^;]*(;|$)/,
					''
					// Remove any CSP restrictions, as we cannot use custom protocols apparently? (https://issues.chromium.org/issues/373928202)
					// `frame-ancestors 'self' vscode-webview://* https://*.vscode-cdn.net http://localhost:${proxyPort} ;`
				);

				// Allow 'unsafe-inline' and 'unsafe-eval'.
				//  If there's an explicit script-src, add them there; otherwise add them to default-src.
				if (/script-src/.test(cspHeader)) {
					// Append unsafe-inline / unsafe-eval to script-src
					cspHeader = cspHeader.replace(
						/(script-src[^;]+)/,
						`$1 'unsafe-inline' 'unsafe-eval'`
					);
				} else {
					// No script-src directive → use default-src
					cspHeader = cspHeader.replace(
						/(default-src[^;]+)/,
						`$1 'unsafe-inline' 'unsafe-eval'`
					);
				}

				headers['content-security-policy'] = cspHeader;
			}


			delete headers['transfer-encoding'];
			delete headers['content-encoding'];
			headers['content-length'] = Buffer.byteLength(modifiedBody).toString();

			(res as http.ServerResponse).writeHead(proxyRes.statusCode || 200, headers);
			(res as http.ServerResponse).end(modifiedBody);
		});
	});
}

function extractNonce(cspHeader: string): string | null {
	if (!cspHeader) {
		return null;
	}
	// Regular expression to match nonce pattern in either script-src or default-src
	const nonceRegex = /(?:script-src|default-src)[^;]*'nonce-([^']+)'/;

	const match = cspHeader.match(nonceRegex);

	// Return the nonce value if found, otherwise null
	return match ? match[1] : null;
}

export type ProxyResult = {
	proxyPort: number;
	cleanup: () => void;
};


export function proxy(port: number, reactDevtoolsPort: number): Promise<ProxyResult> {
	const maxAttempts = 10;
	let attempt = 0;
	let proxyPort = 8000;

	function tryListen(resolve: (result: ProxyResult) => void, reject: (reason?: any) => void) {

		// NOTE: changeOrigin and ws are important if your app/server uses WebSockets.
		// Also helps avoid refused requests if the dev server checks the Host header.
		const proxyServer = httpProxy.createProxyServer({
			target: `http://localhost:${port}`,
			changeOrigin: true,
			ws: true,
			selfHandleResponse: true,
		});

		const server = http.createServer((req, res) => {
			proxyServer.web(req, res);
		});

		// Forward WebSocket upgrade requests
		server.on('upgrade', (req, socket, head) => {
			proxyServer.ws(req, socket, head);
		});

		// Intercept the response to inject script
		startInterceptingDocument(proxyServer, reactDevtoolsPort);

		// Handle proxy errors
		proxyServer.on('error', (err: NodeJS.ErrnoException, req, res) => {
			const message = String(err.code || '');
			const isTargetNotUp =
				message.includes('ECONNREFUSED') ||
				message.includes('ENOTFOUND') ||
				message.includes('ECONNRESET');

			if (res instanceof http.ServerResponse) {
				if (isTargetNotUp) {
					console.warn(`Proxy could not reach target http://localhost:${port} - ${err.message}`);
					res.writeHead(503, { 'Content-Type': 'text/plain' });
					res.end(`Upstream server on port ${port} is not available. Please start it and try again.`);
				} else {
					console.error('Proxy error:', err);
					res.writeHead(500, { 'Content-Type': 'text/plain' });
					res.end('An unexpected error occurred while processing the proxy request.');
				}
			} else {
				// Raw socket scenario
				console.error('Proxy socket error:', err);
				req.socket?.destroy(err);
			}
		});

		// Handle server "listening" event
		server.once('listening', () => {
			resolve({
				proxyPort: proxyPort,
				cleanup: cleanup.bind(null, proxyServer, server),
			});
		});

		// Handle server "error" event (e.g., port in use)
		server.once('error', (err: NodeJS.ErrnoException) => {
			if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
				cleanup(proxyServer, server);
				attempt++;
				proxyPort++;
				tryListen(resolve, reject);
			} else {
				cleanup(proxyServer, server);
				reject(err);
			}
		});

		server.listen(proxyPort);
	}

	return new Promise(tryListen);
}
