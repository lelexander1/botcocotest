const { zombieSessions, ROLES_INFO } = require('./zombie');

async function handleCommand(ctx) {
    const { sock, m, from, sender, args, command } = ctx;
    let session = zombieSessions.get(from);

    if (!session || session.estado !== 'jugando') return false;
    
    const jugador = session.jugadores.get(sender);
    if (!jugador) return false;
    
    if (!jugador.vivo) {
        await sock.sendMessage(from, { text: `💀 Estás muerto y eres parte de la horda. No puedes realizar acciones.` }, { quoted: m });
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

    // COMANDO SAQUEAR (También suma progreso y da recursos con riesgo)
    if (command === 'saquear') {
        const exito = Math.random() > 0.4;
        if (exito) {
            jugador.inventario.balas += 1;
            session.progresoFase += 1; // Saquear con éxito también ayuda a avanzar la zona
            await sock.sendMessage(from, { text: `🎒 ¡Saqueo exitoso! Encontraste munición útil entre los escombros. (+1 progreso de zona)` }, { quoted: m });
        } else {
            let dano = jugador.rolKey === 'lucia' ? 20 : 10;
            jugador.vida -= dano;
            await sock.sendMessage(from, { text: `⚠️ ¡Hiciste demasiado ruido al buscar! Un infectado te emboscó. Pierdes ${dano} de vida.` }, { quoted: m });
            await verificarMuerte(sock, from, sender, session, jugador);
        }

        // Evaluar si con este saqueo completaron la fase (necesitan 3 puntos de progreso)
        if (session.jugadores.get(sender)?.vivo && session.progresoFase >= 3) {
            await avanzarFase(sock, from, session);
        }
        return true;
    }

    // COMANDO ACCIÓN PRINCIPAL
    if (command === 'accion') {
        const accionTexto = args.join(' ');
        if (!accionTexto) {
            await sock.sendMessage(from, { text: `⚠️ Debes describir qué haces. Ej: *#accion disparo a la puerta para abrir paso*` }, { quoted: m });
            return true;
        }

        const roll = Math.random();
        let resultadoTxt = '';

        if (roll > 0.3) {
            // ÉXITO
            session.progresoFase += 1;
            resultadoTxt = `✅ *ACCIÓN EXITOSA:* ${ROLES_INFO[jugador.rolKey].nombre} ejecutó su plan a la perfección. *(Progreso de zona: ${session.progresoFase}/3)*`;
        } else {
            // FALLO Y DEBUFF
            let dano = jugador.rolKey === 'lucia' ? 30 : 15;
            jugador.vida -= dano;

            if (jugador.rolKey === 'mateo') {
                resultadoTxt = `💥 *¡FALLO CRÍTICO!* A Mateo se le encasquilló el arma y el eco lo dejó sordo temporalmente. Pierdes ${dano} HP.`;
            } else if (jugador.rolKey === 'valeria') {
                resultadoTxt = `💥 *¡FALLO CRÍTICO!* Hay demasiados zombis cerca; a Valeria le tiemblan las manos y bota los botiquines. Pierdes ${dano} HP.`;
            } else if (jugador.rolKey === 'renzo') {
                resultadoTxt = `💥 *¡FALLO CRÍTICO!* El espacio cerrado activa la claustrofobia de Renzo, congelándolo del pánico. Pierdes ${dano} HP.`;
            } else {
                resultadoTxt = `💥 *¡FALLO CRÍTICO!* La avaricia cegó a Lucía y cayó en una trampa de infectados. Recibe daño masivo (${dano} HP).`;
            }
        }

        await sock.sendMessage(from, { text: resultadoTxt }, { quoted: m });
        await verificarMuerte(sock, from, sender, session, jugador);

        // EVALUAR CAMBIO DE FASE SI ALGUIEN SIGUE VIVO
        if (session.estado === 'jugando' && session.progresoFase >= 3) {
            await avanzarFase(sock, from, session);
        }
        return true;
    }

    return false;
}

// FUNCIONES DE CONTROL Y AVANCE DE FASES
async function verificarMuerte(sock, from, sender, session, jugador) {
    if (jugador.vida <= 0) {
        jugador.vivo = false;

        // Castigo a todo o nada: Pierde todo su dinero en la base de datos
        if (session.dbRef) {
            try {
                await session.dbRef.updateOne({ jid: sender }, { $set: { soles: 0 } });
            } catch (err) {
                console.error('Error aplicando castigo:', err);
            }
        }

        await sock.sendMessage(from, { 
            text: `💀 *¡@${sender.split('@')[0]} HA MUERTO!* Devorado por la horda. Al ser juego a todo o nada, *pierde todo su dinero* y queda fuera.`,
            mentions: [sender] 
        });

        let vivos = Array.from(session.jugadores.values()).filter(j => j.vivo).length;
        if (vivos === 0) {
            zombieSessions.delete(from);
            await sock.sendMessage(from, { text: `☠️ *FIN DEL JUEGO.* Todo el equipo ha perecido en las calles de Lima. ¡Banca rota general!` });
        }
    }
}

async function avanzarFase(sock, from, session) {
    session.faseActual += 1;
    session.progresoFase = 0; // Reiniciar puntos para la siguiente zona

    let textoSiguiente = '';

    switch (session.faseActual) {
        case 2:
            textoSiguiente = `📍 *FASE 2: EL DESCENSO POR JAVIER PRADO*\n\n` +
                `La vía expresa está atestada de carros chocados y esqueletos. Es una zona muy abierta con poca cobertura.\n\n` +
                `⚠️ *Evento:* ¡Lluvia de infectados desde los puentes peatonales!\n` +
                `💬 Escriban *#accion* para defenderse o *#saquear* para buscar recursos.`;
            break;
        case 3:
            textoSiguiente = `📍 *FASE 3: EL PUENTE DEL RÍO RÍMAC*\n\n` +
                `Atraviesan el puente estrecho rodeados de agua contaminada y neblina espesa.\n\n` +
                `⚠️ *Evento:* Un mutante colosal bloquea el paso y exige una táctica combinada.\n` +
                `💬 Usen *#accion* para abrirse paso.`;
            break;
        case 4:
            textoSiguiente = `📍 *FASE 4: LAS CATACUMBAS DEL CENTRO HISTÓRICO*\n\n` +
                `Obligados a huir bajo tierra por un bombardeo químico. Huele a humedad y oscuridad absoluta.\n\n` +
                `⚠️ *Evento:* Apagón total y trampa de gas lacrimógeno militar.\n` +
                `💬 Mantengan la calma y escriban *#accion* o usen suministros.`;
            break;
        case 5:
            textoSiguiente = `📍 *FASE 5: LA RECTA FINAL AL PUERTO DEL CALLAO*\n\n` +
                `¡El último tramo! Las garitas de la marea humana están a la vista.\n\n` +
                `⚠️ *Evento:* La puerta blindada del muelle está cerrada con panel electrónico.\n` +
                `💬 Último esfuerzo con *#accion* para alcanzar la salvación.`;
            break;
        case 6:
            // VICTORIA TOTAL
            let vivos = Array.from(session.jugadores.entries()).filter(([jid, datos]) => datos.vivo);
            let premioPersona = Math.floor(session.pozo / vivos.length);

            textoSiguiente = `🚢 *¡EXTRACCIÓN EXITOSA EN EL CALLAO!* 🚢\n\n` +
                `¡Lo lograron! El equipo restante aborda el barco mientras el puerto explota a sus espaldas.\n\n` +
                `🏆 *VICTORIA ABSOLUTA.*\n` +
                `💵 Pozo total repartido: *+${premioPersona} soles* para cada sobreviviente.`;

            // Entregar el premio en la base de datos a los sobrevivientes
            if (session.dbRef && vivos.length > 0) {
                for (let [jid] of vivos) {
                    try {
                        await session.dbRef.updateOne({ jid }, { $inc: { soles: premioPersona } });
                    } catch (e) {
                        console.error('Error entregando premio:', e);
                    }
                }
            }

            zombieSessions.delete(from);
            break;
    }

    await sock.sendMessage(from, { text: textoSiguiente });
}

module.exports = { handleCommand };