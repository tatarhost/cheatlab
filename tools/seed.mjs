const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CID = 'seed-device-000000000000';

const ITEMS = [
  {
    type: 'script',
    title: 'Aimbot для Roblox (Luau)',
    language: 'luau',
    tags: ['aimbot', 'roblox', 'executor'],
    body: `-- плавное наведение на ближайшую цель
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local localPlayer = Players.LocalPlayer

local FOV = 120
local SMOOTH = 0.18

local function closestCharacter()
    local best, bestDistance = nil, math.huge
    for _, other in Players:GetPlayers() do
        if other ~= localPlayer and other.Character and other.Character:FindFirstChild("Head") then
            local distance = (other.Character.Head.Position - camera.CFrame.Position).Magnitude
            if distance < bestDistance then
                best, bestDistance = other.Character, distance
            end
        end
    end
    return best
end

RunService.RenderStepped:Connect(function()
    local target = closestCharacter()
    local head = target and target:FindFirstChild("Head")
    if not head then return end

    local delta = (head.Position - camera.CFrame.Position) * SMOOTH
    camera.CFrame = camera.CFrame + delta
end)`,
    files: [{ name: 'aimbot.lua', body: '-- полный файл эксплойта\nprint("hello from exploit")\n' }],
  },
  {
    type: 'script',
    title: 'Спидхак ходьбы 1.0',
    language: 'luau',
    tags: ['speed', 'roblox'],
    body: `local humanoid = game:GetService("Players").LocalPlayer.Character.Humanoid
humanoid.WalkSpeed = 120
humanoid.JumpPower = 90`,
  },
  {
    type: 'app',
    title: 'Mod menu 2.4 (apk)',
    language: 'text',
    tags: ['apk', 'mod-menu', 'android'],
    body: `Сборка 2.4, armeabi-v7a.\n\nЧто внутри:\n- оверлей с тумблерами\n- подмена скорости передвижения\n- сохранение настроек в файл\n\nУстановка: отключить проверку установки из неизвестных источников, поставить apk, выдать доступ к оверлею.`,
    files: [
      { name: 'mod-menu-2.4.apk', body: 'PK\x03\x04'.repeat(512) },
      { name: 'readme.txt', body: 'Сборка 2.4\narmeabi-v7a\nmin sdk 24\n' },
    ],
  },
  {
    type: 'paste',
    title: 'Хоткеи для локального редактора',
    language: 'text',
    tags: ['hotkeys', 'config'],
    body: `F1  открыть меню
F2  сохранить
F6  включить/выключить обход
F9  закрыть
Ctrl+Shift+R  перезагрузить скрипт`,
  },
  {
    type: 'paste',
    title: 'user.ini для запуска через прокси',
    language: 'text',
    tags: ['config', 'proxy'],
    body: `[proxy]
mode = direct
host =
port = 0
`,
  },
  {
    type: 'app',
    title: 'Инжектор DLL (x64)',
    language: 'text',
    tags: ['dll', 'injector', 'pc'],
    body: 'Собирается из исходников в папке src. Visual Studio 2022, x64 Release. Нужен .NET 6.',
      files: [{ name: 'injector.h', body: '#pragma once\n#include <windows.h>\n' }],
    },
];

async function post(item) {
  const res = await fetch(`${BASE}/api/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cheatlab-client': CID },
    body: JSON.stringify({ ...item, body: item.body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${item.title}: ${data.error || res.status}`);

  for (const f of item.files || []) {
    const up = await fetch(`${BASE}/api/items/${data.item.id}/files`, {
      method: 'POST',
      headers: { 'x-cheatlab-client': CID, 'x-filename': encodeURIComponent(f.name) },
      body: Buffer.from(f.body, 'binary'),
    });
    if (!up.ok) throw new Error(`${f.name}: ${(await up.json()).error || up.status}`);
  }
  return data.item;
}

for (const item of ITEMS) {
  const created = await post(item);
  console.log(`  ${created.id}  ${created.type.padEnd(6)} ${created.title}`);
}
console.log(`\n  ${ITEMS.length} публикаций создано`);
