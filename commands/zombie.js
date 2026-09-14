const zombieSessions = new Map();

const ROLES_INFO = {
    machin: { 
        tipo: 'Tanque', 
        nombre: 'Machín (Pataclaun)', 
        vida: 120, 
        arma: 'Barreta de construcción y comba',
        desc: 'Absorbe daño en primera línea a punta de lisuras y fierro.' 
    },
    sideral: { 
        tipo: 'Tanque / DPS', 
        nombre: 'Sideral (La Chocolateada)', 
        vida: 110, 
        arma: 'Cajas de chocolate explosivas y cócteles molotov',
        desc: 'Especialista en control de masas y caos explosivo.' 
    },
    uchulu: { 
        tipo: 'Healer', 
        nombre: 'La Uchulu', 
        vida: 85, 
        arma: 'Cerbatana con dardos tranquilizantes y machete',
        desc: 'Cura y mantiene al equipo con remedios de la selva.' 
    },
    smiley: { 
        tipo: 'DPS', 
        nombre: 'Smiley / Smash', 
        vida: 90, 
        arma: 'Katana de chifa y guantes con placas de metal',
        desc: 'Daño crítico cuerpo a cuerpo con velocidad de esports.' 
    },
    zeein: { 
        tipo: 'DPS', 
        nombre: 'El Zeein / Peluchín', 
        vida: 90, 
        arma: 'Rifle de asalto con luces LED y ballesta',
        desc: 'Precisión letal y fuego de cobertura constante.' 
    },
    kingteka: { 
        tipo: 'DPS', 
        nombre: 'Kingteka', 
        vida: 100, 
        arma: 'Machetes dobles',
        desc: 'Cortando hordas con experiencia profesional.' 
    },
    goblinciano: { 
        tipo: 'DPS / Soporte', 
        nombre: 'Goblinciano', 
        vida: 85, 
        arma: 'Torretas automáticas y trampas explosivas',
        desc: 'Controla el perímetro con tecnología y trampas caseras.' 
    },
    magaly: { 
        tipo: 'Soporte / Utilidad', 
        nombre: 'Magaly TV', 
        vida: 80, 
        arma: 'Drones de reconocimiento y cámaras ocultas',
        desc: 'Detecta amenazas antes de tiempo y expone a los infectados.' 
    }
};

async function handleCommand(ctx) {
    const { sock, m, from, sender, args, command, usersCollection, economyCollection } = ctx;
    const db = usersCollection || economyCollection;

    if (command === 'zombie' || command === 'zombies') {
        const subCommand = args[0]?.toLowerCase();
        let session = zombieSessions.get(from);

        if (!subCommand || subCommand === 'iniciar') {
            if (session) {
                await sock.sendMessage(from, { text: '⚠️ Ya hay una partida de supervivencia organizándose. Usa *#zombie unirse [personaje]*.' }, { quoted: m });
                return true;
            }

            const nuevaSesion = {
                lider: sender,
                jugadores: new Map(),
                faseActual: 0,
                estado: 'reclutamiento',
                progresoFase: 0,
                pozo: 0,
                dbRef: db
            };

            zombieSessions.set(from, nuevaSesion);

            let texto = `🧟‍♂️ *¡LA FIEBRE DE LA BRUMA HA LLEGADO A HUAYCÁN!* 🧟‍♀️\n\n`;
            texto += `El polvo y la neblina tóxica cubren las faldas de los cerros. La evacuación final es en el Callao.\n`;
            texto += `👥 Hasta *8 sobrevivientes* en el convoy (o inicia en 5 min).\n`;
            texto += `💰 *Entrada:* 5,000 soles al pozo.\n🏆 *Premio:* 100,000 soles a los sobrevivientes.\n💀 *Modo:* ¡A todo o nada (si mueres pierdes todo tu dinero)!\n\n`;
            texto += `*PERSONAJES DISPONIBLES:*\n`;
            texto += `🧱 *#zombie unirse machin* (Tanque)\n`;
            texto += `🍫 *#zombie unirse sideral* (Tanque/DPS)\n`;
            texto += `🍃 *#zombie unirse uchulu* (Healer)\n`;
            texto += `🥢 *#zombie unirse smiley* (DPS)\n`;
            texto += `💡 *#zombie unirse zeein* (DPS)\n`;
            texto += `⚔️ *#zombie unirse kingteka* (DPS)\n`;
            texto += `🤖 *#zombie unirse goblinciano* (DPS/Soporte)\n`;
            texto += `📸 *#zombie unirse magaly* (Soporte/Utilidad)\n\n`;
            texto += `💬 Escribe el comando para elegir tu héroe y asegurar tu lugar.`;

            await sock.sendMessage(from, { text: texto }, { quoted: m });

            // Temporizador de 5 minutos por si no se llena la sala
            nuevaSesion.timeoutInicio = setTimeout(async () => {
                let currentSession = zombieSessions.get(from);
                if (currentSession && currentSession.estado === 'reclutamiento') {
                    if (currentSession.jugadores.size > 0) {
                        await sock.sendMessage(from, { text: `⏰ *¡TIEMPO AGOTADO!* El convoy arranca de emergencia con los ${currentSession.jugadores.size} sobrevivientes inscritos.` });
                        await arrancarJuego(sock, from, currentSession);
                    } else {
                        zombieSessions.delete(from);
                        await sock.sendMessage(from, { text: `⏰ La sala de supervivencia expiró por falta de jugadores.` });
                    }
                }
            }, 300000);

            return true;
        }

        if (subCommand === 'unirse') {
            if (!session || session.estado !== 'reclutamiento') {
                await sock.sendMessage(from, { text: '❌ No hay ninguna sala de supervivencia abierta para unirse.' }, { quoted: m });
                return true;
            }

            const personajeElegido = args[1]?.toLowerCase();
            if (!ROLES_INFO[personajeElegido]) {
                await sock.sendMessage(from, { text: '❌ Personaje no válido. Elige entre: *machin, sideral, uchulu, smiley, zeein, kingteka, goblinciano, magaly*.' }, { quoted: m });
                return true;
            }

            // Verificar si el personaje ya fue tomado por otro jugador
            for (let [jugador, datos] of session.jugadores.entries()) {
                if (datos.rolKey === personajeElegido) {
                    await sock.sendMessage(from, { text: `⚠️ El personaje *${ROLES_INFO[personajeElegido].nombre}* ya fue seleccionado por otro compañero.` }, { quoted: m });
                    return true;
                }
            }

            if (session.jugadores.has(sender)) {
                await sock.sendMessage(from, { text: '⚠️ Ya estás inscrito en el equipo.' }, { quoted: m });
                return true;
            }

            if (session.jugadores.size >= 8) {
                await sock.sendMessage(from, { text: '⚠️ El convoy ya está lleno (máximo 8 sobrevivientes).' }, { quoted: m });
                return true;
            }

            if (db) {
                const userEco = await db.findOne({ jid: sender });
                const saldo = userEco?.soles || userEco?.wallet || 0;
                if (saldo < 5000) {
                    await sock.sendMessage(from, { text: `❌ Necesitas 💰 *5,000 soles* en tu cuenta para pagar tu asiento en el convoy.` }, { quoted: m });
                    return true;
                }
                await db.updateOne({ jid: sender }, { $inc: { soles: -5000 } });
            }

            session.jugadores.set(sender, {
                rolKey: personajeElegido,
                vida: ROLES_INFO[personajeElegido].vida,
                arma: ROLES_INFO[personajeElegido].arma,
                inventario: { medicinas: 1, bebidas: 1, balas: 2 },
                vivo: true
            });
            session.pozo += 5000;

            const infoPJ = ROLES_INFO[personajeElegido];
            await sock.sendMessage(from, { 
                text: `✅ @${sender.split('@')[0]} se ha unido como *${infoPJ.nombre}* (${infoPJ.tipo}).\n हथियार (Arma): _${infoPJ.arma}_\nSobrevivientes listos: ${session.jugadores.size}/8.`,
                mentions: [sender]
            }, { quoted: m });

            // Si se llenan los 8 cupos, arranca de inmediato
            if (session.jugadores.size === 8) {
                clearTimeout(session.timeoutInicio);
                await arrancarJuego(sock, from, session);
            }
            return true;
        }

        if (subCommand === 'comenzar') {
            if (!session || session.estado !== 'reclutamiento') return false;
            if (session.lider !== sender) {
                await sock.sendMessage(from, { text: '⚠️ Solo el líder del grupo puede arrancar el convoy antes de tiempo.' }, { quoted: m });
                return true;
            }
            if (session.jugadores.size === 0) {
                await sock.sendMessage(from, { text: '⚠️ No hay sobrevivientes en el equipo todavía.' }, { quoted: m });
                return true;
            }

            clearTimeout(session.timeoutInicio);
            await arrancarJuego(sock, from, session);
            return true;
        }
    }
    return false;
}

async function arrancarJuego(sock, from, session) {
    session.estado = 'jugando';
    session.faseActual = 1;
    session.pozo = 100000; // Premio fijo de 100,000 soles

    let textoFase1 = `📍 *FASE 1: EL CAOS EN LAS ALTURAS DE HUAYCÁN*\n\n`;
    textoFase1 += `Los asentamientos humanos han sido desbordados por la horda. El convoy avanza con ${session.jugadores.size} sobrevivientes bajando hacia la Carretera Central.\n\n`;
    textoFase1 += `⚠️ *Evento:* Las pistas están bloqueadas por llantas quemadas y turbas de infectados desesperados por subir.\n`;
    textoFase1 += `💬 Usa *#accion [lo que haces]* para abrirte paso, o *#saquear* para buscar suministros en las casetas abandonadas.`;

    await sock.sendMessage(from, { text: textoFase1 });
}
module.exports = { handleCommand, zombieSessions, ROLES_INFO };