// #region Imports
const { Client } = require('ssh2');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
// #endregion Imports

// #region Server Setup
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    maxHttpBufferSize: 10e6, // 10 МБ
});

const PORT = 5000;
const BACKOFF = [5000, 10000, 30000, 60000, 600000, 3600000]; // 5s, 10s, 30s, 1m, 10m, 1h
// #endregion Server Setup

// #region ServerConnection Class
class ServerConnection {
    constructor(ip, login, password, emitStatus) {
        this.ip = ip;
        this.login = login;
        this.password = password;
        this.backoffIndex = 0;
        this.connected = false;
        this.emitStatus = emitStatus;
        this.keepAlive = null;
        this.reconnectTimeout = null;
        this.client = new Client();
        this.connect();
    }

    connect() {
        this.emitStatus(this.ip, 'offline');

        this.client
            .on('ready', () => this.onReady())
            .on('error', (err) => this.onError(err))
            .on('end', () => this.handleDisconnect())
            .on('close', () => this.handleDisconnect())
            .connect({
                host: this.ip,
                port: 22,
                username: this.login,
                password: this.password,
                readyTimeout: 20000
            });
    }

    onReady() {
        this.connected = true;
        this.backoffIndex = 0;
        this.emitStatus(this.ip, 'online');
        console.log(`Подключено к ${this.ip}`);

        this.keepAlive = setInterval(() => {
            this.client.exec('echo "keep-alive"', (err) => {
                if (err) this.handleDisconnect();
            });
        }, 30000);
    }

    onError(err) {
        console.error(`Ошибка подключения к ${this.ip}:`, err.message);
        this.handleDisconnect();
    }

    handleDisconnect() {
        if (this.connected) {
            this.connected = false;
            this.emitStatus(this.ip, 'offline');
            console.log(`Отключено от ${this.ip}`);
        }
        clearInterval(this.keepAlive);
        this.keepAlive = null;
        this.scheduleReconnect();
    }

    scheduleReconnect() {
        if (this.reconnectTimeout) return;

        const delay = BACKOFF[this.backoffIndex] || BACKOFF[BACKOFF.length - 1];
        console.log(`Попытка переподключения к ${this.ip} через ${delay / 1000} секунд`);

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.connect();
            this.backoffIndex = Math.min(this.backoffIndex + 1, BACKOFF.length - 1);
        }, delay);
    }

    updateCredentials(login, password) {
        if (this.login !== login || this.password !== password) {
            this.login = login;
            this.password = password;
            if (this.connected) {
                console.log(`Обновление учетных данных для ${this.ip}`);
                this.client.end();
            }
        }
    }

    disconnect() {
        clearInterval(this.keepAlive);
        clearTimeout(this.reconnectTimeout);
        this.client.removeAllListeners();
        this.client.end();
    }
}
// #endregion ServerConnection Class

// #region Helper Functions
const emitStatusMap = (socket, statusMap) => {
    socket.emit('server_status', Object.fromEntries(statusMap));
};

const createSocketHandler = (socket) => {
    const serverConnections = new Map();
    const serverStatus = new Map();

    const emitStatus = (ip, status) => {
        serverStatus.set(ip, status);
        emitStatusMap(socket, serverStatus);
    };

    const addServer = (ip, login, password) => {
        if (serverConnections.has(ip)) {
            console.log(`Сервер ${ip} уже добавлен для этого соединения`);
            return;
        }
        const conn = new ServerConnection(ip, login, password, emitStatus);
        serverConnections.set(ip, conn);
        console.log(`Добавлен сервер ${ip} для соединения ${socket.id}`);
    };

    const removeServer = (ip) => {
        if (!serverConnections.has(ip)) {
            console.log(`Сервер ${ip} не найден для этого соединения`);
            return;
        }
        const conn = serverConnections.get(ip);
        conn.disconnect();
        serverConnections.delete(ip);
        serverStatus.delete(ip);
        emitStatusMap(socket, serverStatus);
        console.log(`Удален сервер ${ip} для соединения ${socket.id}`);
    };

    const updateConfig = ({ newServers, newLogin, newPassword }) => {
        const newSet = new Set(newServers);
        const existingServers = new Set(serverConnections.keys());
        const addedServers = [...newSet].filter(ip => !existingServers.has(ip));
        const removedServers = [...existingServers].filter(ip => !newSet.has(ip));

        addedServers.forEach(ip => addServer(ip, newLogin, newPassword));
        removedServers.forEach(ip => removeServer(ip));

        serverConnections.forEach((conn, ip) => conn.updateCredentials(newLogin, newPassword));

        console.log(`Конфигурация обновлена для соединения ${socket.id}:`, { servers: Array.from(newSet), login: newLogin });
    };

    socket.on('configure', (data) => {
        const { servers, login, password } = data;

        if (
            !Array.isArray(servers) ||
            typeof login !== 'string' ||
            typeof password !== 'string'
        ) {
            socket.emit('error', 'Неверный формат конфигурации');
            return;
        }

        updateConfig({ newServers: servers, newLogin: login, newPassword: password });
    });

    socket.on('disconnect', () => {
        console.log(`Соединение ${socket.id} отключено`);
        serverConnections.forEach((conn, ip) => conn.disconnect());
        serverConnections.clear();
        serverStatus.clear();
    });
};
// #endregion Helper Functions

// #region Socket.IO
io.on('connection', (socket) => {
    console.log(`Новый клиент подключился: ${socket.id}`);
    createSocketHandler(socket);
});
// #endregion Socket.IO

// #region Server Start
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
// #endregion Server Start
