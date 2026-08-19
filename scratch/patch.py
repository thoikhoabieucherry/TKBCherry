import codecs

file_path = r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js'

with codecs.open(file_path, 'r', 'utf-8') as f:
    lines = f.readlines()

# Find the start of the block: "// Pha B:"
start_idx = -1
end_idx = -1
for i, line in enumerate(lines):
    if '// Pha B:' in line and 'VAY' in line and start_idx == -1:
        start_idx = i
    if 'return { ...rA, initialMetrics, borrowed: false };' in line and start_idx != -1 and i > start_idx:
        end_idx = i
        break

if start_idx != -1 and end_idx != -1:
    new_block = [
        '        // Pha B: VAY SÂU 3 suất (25% ngân sách) - Deep Simulated Annealing\n',
        '        await runPhase("optimize_gap2", 0.25, { singletonSlack: 3 }, 2);\n',
        '        // Pha C: TRẢ NỢ 1t/buổi (15% ngân sách) - Ép trả nợ\n',
        '        await runPhase("optimize_singletons", 0.15, { singletonSlack: 0, __pushToZero: true }, 3);\n',
        '        // Pha D: quét gap2 chết không vay (10%)\n',
        '        const rD = await runPhase("optimize_gap2", 0.10, { singletonSlack: 0 }, 4);\n',
        '        const fin = { ...rD.metrics };\n\n',
        '        // Nghiệm thu (Rollback nới lỏng):\n',
        '        const okS1 = fin.soBuoiDay1 <= initialMetrics.soBuoiDay1;\n',
        '        // Chấp nhận s1 tăng nhẹ (+1) NHƯNG gap2 giảm mạnh (>= 2)\n',
        '        const acceptableS1 = fin.soBuoiDay1 <= initialMetrics.soBuoiDay1 + 1 && fin.soBuoiTrong2 <= tupleA.soBuoiTrong2 - 2;\n',
        '        const better = this.compareTuple(fin, tupleA) < 0;\n\n',
        '        if((okS1 && better) || acceptableS1){\n',
        '          this.loadExistingSchedule();\n',
        '          return { ...rD, initialMetrics, borrowed: true };\n',
        '        }\n',
        '        // Trả lại phương án không-vay\n',
        '        this.data.tkb = JSON.parse(JSON.stringify(tkbA));\n',
        '        this.loadExistingSchedule();\n',
        '        return { ...rA, initialMetrics, borrowed: false };\n'
    ]
    lines = lines[:start_idx] + new_block + lines[end_idx+1:]
    with codecs.open(file_path, 'w', 'utf-8') as f:
        f.writelines(lines)
    print("Patched successfully.")
else:
    print(f"Could not find block. start={start_idx}, end={end_idx}")
