import quickdraw from './quickdraw.js';
import doodle from './doodle.js';
import tron from './tron.js';
import hockey from './hockey.js';
import sumo from './sumo.js';
import connect4 from './connect4.js';
import battleship from './battleship.js';
import mindreader from './mindreader.js';

export const GAME_LIST = [doodle, quickdraw, hockey, sumo, tron, mindreader, battleship, connect4];
export const GAMES = Object.fromEntries(GAME_LIST.map((g) => [g.id, g]));
