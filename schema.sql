CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT, t INTEGER);
CREATE TABLE IF NOT EXISTS knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, pregunta TEXT, respuesta TEXT);
CREATE TABLE IF NOT EXISTS conversaciones (id INTEGER PRIMARY KEY AUTOINCREMENT, reserva TEXT, pregunta TEXT, respuesta TEXT, fecha TEXT);
CREATE TABLE IF NOT EXISTS traducciones (lang TEXT, src TEXT, dst TEXT, PRIMARY KEY (lang, src));
CREATE TABLE IF NOT EXISTS solicitudes (id INTEGER PRIMARY KEY AUTOINCREMENT, reserva TEXT, tipo TEXT, detalle TEXT, fecha TEXT);
INSERT INTO knowledge (pregunta, respuesta) VALUES ('Entrada', 'Tomar la entrada al frente a Mystic Sushi o la entrada a Invictus.');
INSERT INTO knowledge (pregunta, respuesta) VALUES ('Vehículo', 'Recomendable 4x4, pero el camino está para todo tipo de vehículos.');
