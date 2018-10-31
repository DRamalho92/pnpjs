import { ODataBatch } from "@pnp/odata";
import { Logger, LogLevel } from "@pnp/logging";
import { extend, jsS, isUrlAbsolute } from "@pnp/common";
import { GraphRuntimeConfig } from "./config/graphlibconfig";
import { GraphHttpClient } from "./net/graphhttpclient";

interface GraphBatchRequestFragment {
    id: string;
    method: string;
    url: string;
    headers?: string[][] | {
        [key: string]: string;
    };
    body?: any;
}

interface GraphBatchRequest {
    requests: GraphBatchRequestFragment[];
}

interface GraphBatchResponseFragment {
    id: string;
    status: number;
    statusText?: string;
    method: string;
    url: string;
    headers?: string[][] | {
        [key: string]: string;
    };
    body?: any;
}

interface GraphBatchResponse {
    responses: GraphBatchResponseFragment[];
    nextLink?: string;
}

export class GraphBatch extends ODataBatch {

    constructor(private batchUrl = "https://graph.microsoft.com/v1.0/$batch") {
        super();
    }

    protected executeImpl(): Promise<void> {

        Logger.write(`[${this.batchId}] (${(new Date()).getTime()}) Executing batch with ${this.requests.length} requests.`, LogLevel.Info);

        if (this.requests.length < 1) {
            Logger.write(`Resolving empty batch.`, LogLevel.Info);
            return Promise.resolve();
        }

        const client = new GraphHttpClient();

        const batchRequest: GraphBatchRequest = {
            requests: this.formatRequests(),
        };

        const batchOptions = {
            body: jsS(batchRequest),
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            method: "POST",
        };

        Logger.write(`[${this.batchId}] (${(new Date()).getTime()}) Sending batch request.`, LogLevel.Info);

        return client.fetch(this.batchUrl, batchOptions)
            .then(r => r.json())
            .then((j) => this._parseResponse(j))
            .then((parsedResponse: { nextLink: string, responses: Response[] }) => {

                Logger.write(`[${this.batchId}] (${(new Date()).getTime()}) Resolving batched requests.`, LogLevel.Info);

                return parsedResponse.responses.reduce((chain, response, index) => {

                    const request = this.requests[index];

                    Logger.write(`[${this.batchId}] (${(new Date()).getTime()}) Resolving batched request ${request.method} ${request.url}.`, LogLevel.Verbose);

                    return chain.then(_ => request.parser.parse(response).then(request.resolve).catch(request.reject));

                }, Promise.resolve());
            });
    }

    /**
     * Urls come to the batch absolute, but the processor expects relative
     * @param url Url to ensure is relative
     */
    private makeUrlRelative(url: string): string {

        if (!isUrlAbsolute(url)) {
            // already not absolute, just give it back
            return url;
        }

        let index = url.indexOf(".com/v1.0/");

        if (index < 0) {

            index = url.indexOf(".com/beta/");

            if (index > -1) {

                // beta url
                return url.substr(index + 10);
            }

        } else {
            // v1.0 url
            return url.substr(index + 9);
        }

        // no idea
        return url;
    }

    private formatRequests(): GraphBatchRequestFragment[] {

        return this.requests.map((reqInfo, index) => {

            let requestFragment: GraphBatchRequestFragment = {
                id: `${++index}`,
                method: reqInfo.method,
                url: this.makeUrlRelative(reqInfo.url),
            };

            let headers = {};

            // merge global config headers
            if (GraphRuntimeConfig.headers !== undefined && GraphRuntimeConfig.headers !== null) {

                headers = extend(headers, GraphRuntimeConfig.headers);
            }

            if (reqInfo.options !== undefined) {

                // merge per request headers
                if (reqInfo.options.headers !== undefined && reqInfo.options.headers !== null) {
                    headers = extend(headers, reqInfo.options.headers);
                }

                // add a request body
                if (reqInfo.options.body !== undefined && reqInfo.options.body !== null) {

                    requestFragment = extend(requestFragment, {
                        body: reqInfo.options.body,
                    });
                }
            }

            requestFragment = extend(requestFragment, {
                headers: headers,
            });

            return requestFragment;
        });
    }

    private _parseResponse(graphResponse: GraphBatchResponse): Promise<{ nextLink: string, responses: Response[] }> {

        return new Promise((resolve) => {

            const parsedResponses: Response[] = new Array(this.requests.length).fill(null);

            for (let i = 0; i < graphResponse.responses.length; ++i) {

                const response = graphResponse.responses[i];
                // we create the request id by adding 1 to the index, so we place the response by subtracting one to match
                // the array of requests and make it easier to map them by index
                const responseId = parseInt(response.id, 10) - 1;

                if (response.status === 204) {

                    parsedResponses[responseId] = new Response();
                } else {

                    parsedResponses[responseId] = new Response(JSON.stringify(response.body), response);
                }
            }

            resolve({
                nextLink: graphResponse.nextLink,
                responses: parsedResponses,
            });
        });
    }
}

