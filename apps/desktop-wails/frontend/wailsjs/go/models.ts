export namespace main {
	
	export class ConnectionInfo {
	    baseUrl: string;
	    wsUrl: string;
	    token: string;
	    authMode: string;
	    mode: string;
	    isFullscreen: boolean;
	    nativeOverlayWidth: number;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.baseUrl = source["baseUrl"];
	        this.wsUrl = source["wsUrl"];
	        this.token = source["token"];
	        this.authMode = source["authMode"];
	        this.mode = source["mode"];
	        this.isFullscreen = source["isFullscreen"];
	        this.nativeOverlayWidth = source["nativeOverlayWidth"];
	    }
	}
	export class ProxyApiRequest {
	    path: string;
	    method: string;
	    body: string;
	
	    static createFrom(source: any = {}) {
	        return new ProxyApiRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.method = source["method"];
	        this.body = source["body"];
	    }
	}
	export class ProxyApiResponse {
	    status: number;
	    body: string;
	
	    static createFrom(source: any = {}) {
	        return new ProxyApiResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.status = source["status"];
	        this.body = source["body"];
	    }
	}
	export class SelectPathsRequest {
	    title: string;
	    defaultPath: string;
	    directories: boolean;
	    multiple: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SelectPathsRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.title = source["title"];
	        this.defaultPath = source["defaultPath"];
	        this.directories = source["directories"];
	        this.multiple = source["multiple"];
	    }
	}
	export class TerminalSession {
	    ID: string;
	    Shell: string;
	    Cwd: string;
	    Cols: number;
	    Rows: number;
	
	    static createFrom(source: any = {}) {
	        return new TerminalSession(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ID = source["ID"];
	        this.Shell = source["Shell"];
	        this.Cwd = source["Cwd"];
	        this.Cols = source["Cols"];
	        this.Rows = source["Rows"];
	    }
	}

}

