// Backend server configuration
// IMPORTANT: If you change BACKEND_PORT, you must also update:
// 1. manifest.json host_permissions to match (e.g., "http://127.0.0.1:5020/*")
// 2. server.py to run on the same port (line 837: app.run(debug=True, port=5020))
const CONFIG = {
    BACKEND_HOST: '127.0.0.1',
    BACKEND_PORT: 5020,
    get BACKEND_URL() {
        return `http://${this.BACKEND_HOST}:${this.BACKEND_PORT}`;
    }
};
