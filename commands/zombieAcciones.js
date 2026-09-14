const { zombieSessions, ROLES_INFO } = require('./zombie');

async function handleCommand(ctx) {
    const { sock, m, from, sender, args, command, text } = ctx;
    let session = zombieSessions.get(from);

    if (!session || session.estado !== 'jugando') return false;
    
    const jugador = session.jugadores.get(sender);
    if (!jugador) return false;
    if (!jugador.vivo) {
        await sock.sendMessage(from, { text: `💀 Estás muerto. Eres un zombie más vagando por Lima. No puedes actuar.` }, { quoted: m });
        return true;
    }

    // COMANDO ESTADO
    if (command === 'estado') {
        const info = ROLES_INFO[jugador.rolKey];
        let txt = `📊 *ESTADO DE ${info.nombre}*\n`;
        txt += `❤️ Vida: ${jugador.vida}/${info.vida}\n`;
        txt += `🎒 Inventario: ${jugador.inventario.medicinas} medicinas, ${jugador.inventario.bebidas} bebidas energéticas, ${jugador.inventario.balas} balas.`;
        await sock.sendMessage(from, { text: txt }, { quoted: m });
        return true;
    }

    // COMANDO SAQUEAR (Aplica el debuff de Lucía)
    if (command === 'saquear') {
        const exito = Math.random() > 0.5;
        if (exito) {
            jugador.inventario.balas += 1;
            await sock.sendMessage(from, { text: `🎒 Encontraste balas entre los escombros.` }, { quoted: m });
        } else {
            let dano = jugador.rolKey === 'lucia' ? 20 : 10; // Lucía recibe el doble de daño
            jugador.vida -= dano;
            await sock.sendMessage(from, { text: `⚠️ ¡Hiciste ruido! Un infectado te atacó por la espalda. Pierdes ${dano} de vida.` }, { quoted: m });
            await verificarMuerte(sock, from, sender, session, jugador);
        }
        return true;
    }

    // COMANDO ACCIÓN PRINCIPAL (El motor del RPG)
    if (command === 'accion') {
        const accionTexto = args.join(' ');
        if (!accionTexto) {
            await sock.sendMessage(from, { text: `⚠️ Debes describir qué haces. Ej: *#accion disparo al candado del bloqueo vecinal*` }, { quoted: m });
            return true;
        }

        // Lógica de RNG / Consecuencia (Aquí entra la probabilidad de activar Debuffs)
        const roll = Math.random();
        let resultadoTxt = '';

        if (roll > 0.3) {
            // ÉXITO DE LA ACCIÓN
            session.progresoFase += 1;
            resultadoTxt = `✅ *ACCIÓN EXITOSA:* ${ROLES_INFO[jugador.rolKey].nombre} logró ejecutar su maniobra. Avanzan en la zona.`;
        } else {
            // FALLO Y ACTIVACIÓN DE DEBUFF SEGÚN ROL
            let dano = jugador.rolKey === 'lucia' ? 30 : 15;
            jugador.vida -= dano;

            if (jugador.rolKey === 'mateo') {
                resultadoTxt = `💥 *FALLO CRÍTICO:* A Mateo se le encasquilla el arma y el ruido lo deja con sordera temporal. Pierdes ${dano} de vida en el pánico.`;
            } else if (jugador.rolKey === 'valeria') {
                resultadoTxt = `💥 *FALLO CRÍTICO:* Los zombis se acercan demasiado. A Valeria le tiemblan las manos y tira sus suministros. Pierdes ${dano} de vida.`;
            } else if (jugador.rolKey === 'renzo') {
                resultadoTxt = `💥 *FALLO CRÍTICO:* La zona es muy estrecha. Renzo sufre un ataque de claustrofobia. Pierdes ${dano} de vida.`;
            } else {
                resultadoTxt = `💥 *FALLO CRÍTICO:* Lucía se arriesgó de más por avaricia y fue emboscada. Recibe daño masivo (${dano} HP).`;
            }
        }

        await sock.sendMessage(from, { text: resultadoTxt }, { quoted: m });
        await verificarMuerte(sock, from, sender, session, jugador);

        // EVALUAR CAMBIO DE FASE
        if (session.progresoFase >= 3) {
            await avanzarFase(sock, from, session);
        }
        return true;
    }
    return false;
}

// FUNCIONES DE SOPORTE
async function verificarMuerte(sock, from, sender, session, jugador) {
    if (jugador.vida <= 0) {
        jugador.vivo = false;

        // Castigo a todo o nada: Pierde todo su dinero actual en la base de datos
        if (session.dbRef) {
            try {
                await session.dbRef.updateOne(
                    { jid: sender },
                    { $set: { soles: 0 } }
                );
            } catch (err) {
                console.error('Error aplicando castigo de muerte en DB:', err);
            }
        }

        await sock.sendMessage(from, { 
            text: `💀 *¡@${sender.split('@')[0]} HA MUERTO!* Ha sido devorado por la horda. Al ser un juego a todo o nada, *ha perdido todo su dinero* y queda fuera de la partida.`,
            mentions: [sender] 
        });

        let vivos = Array.from(session.jugadores.values()).filter(j => j.vivo).length;
        if (vivos === 0) {
            zombieSessions.delete(from);
            await sock.sendMessage(from, { text: `☠️ *FIN DEL JUEGO.* Todo el equipo ha perecido en las calles de Lima. ¡Banca rota para todos!` });
        }
    }
}

async function avanzarFase(sock, from, session) {
    session.faseActual += 1;
    session.progresoFase = 0; // Reiniciar progreso para la nueva fase

    let textoSiguiente = '';
    if (session.faseActual === 2) {
        textoSiguiente = `📍 *FASE 2: EL DESCENSO POR JAVIER PRADO*\n\nLa vía expresa es un cementerio de autos chocados. \n⚠️ *Evento:* ¡Lluvia de infectados! Caen desde el puente peatonal.\n💬 Respondan rápido con *#accion*.`;
    } else if (session.faseActual === 3) {
        textoSiguiente = `📍 *FASE 3: EL PUENTE DEL RÍO RÍMAC*\n\nEl puente está cediendo.\n⚠️ *Evento:* Un mutante colosal bloquea el único carril.\n💬 Preparen sus mejores acciones.`;
    } // Añadir Fase 4 y 5...
    else if (session.faseActual === 6) {
        // VICTORIA
        let vivos = Array.from(session.jugadores.entries()).filter(([jid, datos]) => datos.vivo);
        let premioPersona = Math.floor(session.pozo / vivos.length);
        textoSiguiente = `🚢 *¡EXTRACCIÓN EXITOSA EN EL CALLAO!* 🚢\n\nEl equipo logra abordar el barco mientras el puerto explota a sus espaldas.\n💵 Premio repartido: *+${premioPersona} soles* para cada sobreviviente.`;
        zombieSessions.delete(from);
        
        // Aquí conectas con tu DB para darles el premio a los vivos
        // for(let [jid, datos] of vivos) { await db.updateOne({jid}, {$inc: {soles: premioPersona}}) }
    }

    await sock.sendMessage(from, { text: textoSiguiente });
}

module.exports = { handleCommand };