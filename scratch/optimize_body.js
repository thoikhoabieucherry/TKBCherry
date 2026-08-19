async optimize(mode = "optimize_singletons", progressCallback = null){
      this.loadExistingSchedule();
      // Sửa trùng lịch/tiết đè ô cố định TRƯỚC khi đo đạc: dữ liệu vào hỏng sẽ
      // làm integrity gate (đã mở rộng) từ chối mọi nước đi của operator.
      this.repairHardConflicts();
      // Baseline so tiet da xep sau repair (13.1) — mo neo cho luoi chong rot tiet.
      {
        let basePlaced = 0;
        for(let iB = 0; iB < this.activities.length; iB++){
          if(this.actPlacement[iB] >= 0) basePlaced += this.activities[iB].duration;
        }
        this.__placedBaseline = basePlaced;
      }
      // Baseline lo trong hoc sinh (13.3): nghiem chi duoc GIU hoac GIAM, khong duoc tang.
      this.__studentHoleBaseline = this.countStudentHoles();
      const initialMetrics = this.evaluateMetrics();
      // singletonSlack: cho phép "mượn tạm" N suất 1-tiết/buổi trong lúc tìm
      // đường (đi qua thung lũng mà gate tham lam không bước nổi). Người gọi
      // chịu trách nhiệm TRẢ NỢ (chạy pha 1-tiết/buổi sau đó) và chỉ nhận kết
      // quả nếu tuple cuối không tệ hơn ban đầu. Mặc định 0 — hành vi cũ.
      const slack = Math.max(0, Number(this.options.singletonSlack) || 0);
      this.initialMetricsSnapshot = { ...initialMetrics, soBuoiDay1: initialMetrics.soBuoiDay1 + slack };
      // SEED global best = trạng thái BAN ĐẦU (sửa lỗi nghiêm trọng 17/08):
      // trước đây nếu lượt đầu không cải thiện được gì, __globalBestM không bao
      // giờ được gieo bằng initial — lượt diversify sau đó "cải thiện so với
      // trạng thái đã lay chuyển" rồi gấp vào global best một trạng thái TỆ HƠN
      // ban đầu, và kết quả trả về là rác. Gieo initial ngay từ đầu: kết quả
      // cuối không bao giờ tệ hơn lúc bấm nút.
      this.__globalBestM = { ...initialMetrics };
      this.__globalBestSnap = this.captureStateSnapshot();
      this.checkpointGuard = this.__globalBestSnap;
      const initialStateSnap = this.captureStateSnapshot(); // gốc cho restart đa dạng hóa
      let bestMetrics = { ...initialMetrics };
      let bestPlacement = this.actPlacement.slice();
      let bestClassGrid = new Map();
      this.classGrid.forEach((arr, cid) => bestClassGrid.set(cid, arr.slice()));
      let bestTeacherGrid = new Map();
      this.teacherGrid.forEach((arr, gv) => bestTeacherGrid.set(gv, arr.slice()));
      let bestRoomGrid = new Map();
      this.roomGrid.forEach((arr, rm) => bestRoomGrid.set(rm, arr.slice()));

      // Elite archive of diverse promising configurations
      const eliteArchive = [{
        metrics: { ...initialMetrics },
        placement: this.actPlacement.slice(),
        classGrid: new Map(Array.from(this.classGrid.entries()).map(([k, v]) => [k, v.slice()])),
        teacherGrid: new Map(Array.from(this.teacherGrid.entries()).map(([k, v]) => [k, v.slice()])),
        roomGrid: new Map(Array.from(this.roomGrid.entries()).map(([k, v]) => [k, v.slice()]))
      }];

      const saveBestSnapshot = () => {
        // LUOI CHONG RoT TIET (13.1): khong bao gio ghi nhan "best" co it tiet da xep
        // hon baseline sau repair — metrics dep nho vut tiet la gian lan, cam tuyet doi.
        if(typeof this.__placedBaseline === "number"){
          let placedNow2 = 0;
          for(let i2 = 0; i2 < this.activities.length; i2++){
            if(this.actPlacement[i2] >= 0) placedNow2 += this.activities[i2].duration;
          }
          if(placedNow2 < this.__placedBaseline) return;
        }
        if(typeof this.__studentHoleBaseline === "number" && this.countStudentHoles() > this.__studentHoleBaseline) return;
        bestPlacement = this.actPlacement.slice();
        bestClassGrid = new Map();
        this.classGrid.forEach((arr, cid) => bestClassGrid.set(cid, arr.slice()));
        bestTeacherGrid = new Map();
        this.teacherGrid.forEach((arr, gv) => bestTeacherGrid.set(gv, arr.slice()));

        // Gấp best của lượt chạy vào GLOBAL BEST (xuyên các restart) + neo
        // checkpoint: mọi snapshot gửi ra ngoài từ đây là global best.
        if(!this.__globalBestM || this.compareMetrics(bestMetrics, this.__globalBestM, mode) < 0){
          this.__globalBestM = { ...bestMetrics };
          this.__globalBestSnap = {
            placement: bestPlacement,
            classGrid: bestClassGrid,
            teacherGrid: bestTeacherGrid,
            roomGrid: bestRoomGrid
          };
          this.checkpointGuard = this.__globalBestSnap;
          // DUNG NGAY KHI CHAM 0 (yeu cau 17/08): muc tieu cua mode ve 0 la
          // ngat toan bo operator con lai (opDeadlineMs het han -> vo guard
          // chan moi operator moi), vong round thoat tuc thi, khong restart.
          if(getMetricVal(this.__globalBestM) === 0){
            this.opDeadlineMs = Date.now() - 1;
          }
        }
      };

      const getMetricVal = (m) => {
        if(mode === "optimize_singletons") return m.soBuoiDay1;
        if(mode === "optimize_sessions") return m.tsBuoiDay;
        if(mode === "optimize_gap2") return m.soBuoiTrong2;
        if(mode === "optimize_gap1") return m.soBuoiTrong1;
        return m.soBuoiDay1;
      };

      const notifyLiveProgress = (metrics) => {
        // UI luôn thấy tiến độ ĐƠN ĐIỆU: nếu lượt hiện tại là bước đa dạng hóa
        // (tạm xấu hơn), hiển thị global best thay vì bước dò đường.
        const shown = (this.__globalBestM && this.compareMetrics(this.__globalBestM, metrics, mode) < 0) ? this.__globalBestM : metrics;
        const currentVal = getMetricVal(shown);
        const initialVal = getMetricVal(initialMetrics);
        const pct = Math.min(99, Math.round(((round + 1) / MAX_ROUNDS) * 100));
        if(progressCallback){
          progressCallback({
            percent: pct,
            currentMetric: currentVal,
            initialMetric: initialVal,
            metrics: shown
          });
        }
      };

      if(progressCallback){
        progressCallback({
          percent: 0,
          currentMetric: getMetricVal(bestMetrics),
          initialMetric: getMetricVal(initialMetrics),
          metrics: bestMetrics
        });
      }

      const MAX_ROUNDS = (mode === "optimize_singletons") ? 65 : ((mode === "optimize_gap2") ? 28 : 55);
      let consecutiveUnimprovedRounds = 0;
      const maxStagnantRounds = (mode === "optimize_singletons") ? 25 : ((mode === "optimize_gap2") ? 8 : 18);
      let destroyStrength = 1;
      let round = 0;

      // PORTFOLIO RESTART (gap2/gap1): quan sát thực nghiệm — mỗi pha RNG "mở"
      // được các ca kẹt KHÁC NHAU (seed 101 còn 5, seed 303 còn 2...). Chạy lại
      // từ best với pha mới trong cùng một lần bấm sẽ gộp chiến quả của nhiều
      // seed: ca nào từng có lời giải ở một pha nào đó rồi sẽ được giữ qua best.
      const optStartMs = Date.now();
      const canRestart = !this.__inOptimizeAll &&
        (mode === "optimize_gap2" || mode === "optimize_gap1" || mode === "optimize_singletons");
      const restartTargetVal = 0; // "1 tiet/buoi" phai ve 0 that su, khong dung o 2 (sua 17/08)
      const restartBudgetMs = Number(this.options.optimizeRestartBudgetMs) || 180000;
      const maxRestarts = Number(this.options.optimizeMaxRestarts) || 20;
      const hardCapMs = Number(this.options.optimizeHardCapMs) || 240000;
      this.opDeadlineMs = this.stageDeadlineMs || (optStartMs + hardCapMs);
      let restartCount = 0;
      let portfolioDone = false;

      while(!portfolioDone){
      portfolioDone = true;

      for(round = 0; round < MAX_ROUNDS; round++){
        if(typeof window !== "undefined" && window.__AUTO_SORT_STOP_REQUESTED) break;
        if(this.stageDeadlineMs && Date.now() > this.stageDeadlineMs) break;
        if(Date.now() - optStartMs > hardCapMs) break;

        let improvedInRound = false;
        // Breathing room only matters on the UI thread; workers pass 0.
        const breatheMs = Number.isFinite(Number(this.options.uiBreathingMs)) ? Number(this.options.uiBreathingMs) : 25;
        if(breatheMs > 0) await new Promise(resolve => setTimeout(resolve, breatheMs));

        // 1. Primary Downhill Optimization Passes
        if(mode === "optimize_singletons"){
          // Nuoc chu luc hoc tu cong cu tham chieu (bo MD 17/08): chay DAU TIEN.
          const relabelM = this.trySingletonRelabelCycles(bestMetrics, initialMetrics, notifyLiveProgress);
          if(relabelM && this.compareMetrics(relabelM, bestMetrics, mode) < 0){
            bestMetrics = { ...relabelM };
            saveBestSnapshot();
            improvedInRound = true;
            destroyStrength = 1;
          }

          const resDay = this.fixDaySingletons(bestMetrics, notifyLiveProgress);
          if(resDay && this.compareMetrics(resDay, bestMetrics, mode) < 0){
            bestMetrics = { ...resDay };
            saveBestSnapshot();
            improvedInRound = true;
            destroyStrength = 1;
          }

          const oblitM = this.obliterateAllTeacherSingletons(12, 0, notifyLiveProgress);
          if(oblitM && this.compareMetrics(oblitM, bestMetrics, mode) < 0){
            bestMetrics = { ...oblitM };
            saveBestSnapshot();
            improvedInRound = true;
            destroyStrength = 1;
          }

          const resCross = this.tryIntraClassCrossSubjectSingletonSwap(10, notifyLiveProgress);
          if(resCross && this.compareMetrics(resCross, bestMetrics, mode) < 0){
            bestMetrics = { ...resCross };
            saveBestSnapshot();
            improvedInRound = true;
            destroyStrength = 1;
          }

          const resAugmenting = this.tryAugmentingSingletonEjectionChain(8, notifyLiveProgress);
          if(resAugmenting && this.compareMetrics(resAugmenting, bestMetrics, mode) < 0){
            bestMetrics = { ...resAugmenting };
            saveBestSnapshot();
            improvedInRound = true;
            destroyStrength = 1;
          }

          const resReinforce = this.tryReinforceTeacherSingletons(bestMetrics, initialMetrics, 0, notifyLiveProgress);
          if(resReinforce && this.compareMetrics(resReinforce, bestMetrics, mode) < 0){
            bestMetrics = { ...resReinforce };
            saveBestSnapshot();
            improvedInRound = true;
            destroyStrength = 1;
          }

          const resSingle = this.tryConsolidateTeacherSingletons(bestMetrics, initialMetrics, 0, notifyLiveProgress);
          if(resSingle && this.compareMetrics(resSingle, bestMetrics, mode) < 0){
            bestMetrics = { ...resSingle };
            saveBestSnapshot();
            improvedInRound = true;
            destroyStrength = 1;
          }

          if(bestMetrics.soBuoiDay1 <= restartTargetVal){
            if(progressCallback){
              progressCallback({
                percent: 100,
                currentMetric: bestMetrics.soBuoiDay1,
                initialMetric: Math.max(1, getMetricVal(initialMetrics)),
                metrics: bestMetrics
              });
            }
            portfolioDone = true;
            break;
          }
        }

        if(mode === "optimize_sessions"){
          const resVacate = this.tryVacateTeacherSessions(bestMetrics, initialMetrics, 0, notifyLiveProgress);
          if(resVacate && this.compareMetrics(resVacate, bestMetrics, mode) < 0){
            bestMetrics = { ...resVacate };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const thinSessions = [];
          this.teacherGrid.forEach((tGrid, tKey) => {
            if(!tKey || !this.isScoredTeacher(tKey)) return;
            for(let d = 0; d < DAYS_LIST.length; d++){
              for(let b = 0; b < SESSIONS_LIST.length; b++){
                const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
                let cnt = 0;
                for(let p = 0; p < PERIODS_PER_SESSION; p++){
                  if(tGrid[sStart + p] >= 0 || tGrid[sStart + p] === -3) cnt++;
                }
                if(cnt === 1 || cnt === 2) thinSessions.push({ tKey, d, b, cnt });
              }
            }
          });
          this.rng.shuffle(thinSessions);
          thinSessions.sort((x, y) => x.cnt - y.cnt);

          for(const s of thinSessions.slice(0, 30)){
            const res = this.tryVacateTeacherSession(s.tKey, s.d, s.b, bestMetrics, initialMetrics);
            if(res && this.compareMetrics(res, bestMetrics, mode) < 0){
              bestMetrics = { ...res };
              saveBestSnapshot();
              improvedInRound = true;
              break;
            }
          }

          const oblitThin = this.obliterateAllThinTeacherSessions(8, [1, 2], 0, notifyLiveProgress);
          if(oblitThin && this.compareMetrics(oblitThin, bestMetrics, mode) < 0){
            bestMetrics = { ...oblitThin };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const oblitM = this.obliterateAllTeacherSingletons(8, 0, notifyLiveProgress);
          if(oblitM && this.compareMetrics(oblitM, bestMetrics, mode) < 0){
            bestMetrics = { ...oblitM };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const resSingle = this.tryConsolidateTeacherSingletons(bestMetrics, initialMetrics, 0, notifyLiveProgress);
          if(resSingle && this.compareMetrics(resSingle, bestMetrics, mode) < 0){
            bestMetrics = { ...resSingle };
            saveBestSnapshot();
            improvedInRound = true;
          }
        }

        if(mode === "optimize_gap2"){
          // Ngân sách buổi ĐỘNG (khôi phục kỷ luật cũ, giữ mức trần 20 của bản
          // hợp nhất): vòng đầu chưa được tiêu buổi — ép các nước hoán vị rẻ
          // trước; mở ngân sách khi qua 30% vòng hoặc kẹt 3 vòng liên tiếp.
          if(round >= Math.floor(MAX_ROUNDS * 0.3) || consecutiveUnimprovedRounds >= 3){
            this.gap2SessionBudget = this.options.gap2SessionBudget || 20;
          }else{
            this.gap2SessionBudget = 0;
          }

          // 8 operator quét-nặng (bản AI thứ hai) chỉ chạy Ở TÀN CUỘC (gap2 đã
          // nhỏ): lúc gap2 còn lớn chúng ngốn cả phút mỗi vòng làm portfolio
          // không xoay pha được — các operator rẻ phía dưới hạ 35 -> ~5 trong
          // vài giây, rồi bộ nặng vào kết liễu phần đuôi.
          // Op nặng: chỉ ở tàn cuộc thật (<=3) hoặc thỉnh thoảng khi kẹt (1/3 vòng)
          const heavyOpsOn = (bestMetrics.soBuoiTrong2 || 0) <= 3 || (consecutiveUnimprovedRounds >= 2 && round % 3 === 0);
          if(heavyOpsOn){
          const resBlockSwap = this.tryIntraClassSingleDoubleBlockSwap(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resBlockSwap && this.compareMetrics(resBlockSwap, bestMetrics, mode) < 0){
            bestMetrics = { ...resBlockSwap };
            saveBestSnapshot();
            improvedInRound = true;
          }
          const resRelaxRepair = this.tryRelaxAndRepairGapGaps(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resRelaxRepair && this.compareMetrics(resRelaxRepair, bestMetrics, mode) < 0){
            bestMetrics = { ...resRelaxRepair };
            saveBestSnapshot();
            improvedInRound = true;
          }
          const resCrushExtreme = this.tryCrushExtremeSpanGaps(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resCrushExtreme && this.compareMetrics(resCrushExtreme, bestMetrics, mode) < 0){
            bestMetrics = { ...resCrushExtreme };
            saveBestSnapshot();
            improvedInRound = true;
          }
          const resMergeSplit = this.tryMergeSameTeacherSplitPeriodsInSession(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resMergeSplit && this.compareMetrics(resMergeSplit, bestMetrics, mode) < 0){
            bestMetrics = { ...resMergeSplit };
            saveBestSnapshot();
            improvedInRound = true;
          }
          const resBorrowEarly = this.tryBorrowLessonFromRichSessions(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resBorrowEarly && this.compareMetrics(resBorrowEarly, bestMetrics, mode) < 0){
            bestMetrics = { ...resBorrowEarly };
            saveBestSnapshot();
            improvedInRound = true;
          }
          const resInterDayEarly = this.tryInterDayRelocateGapLesson(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resInterDayEarly && this.compareMetrics(resInterDayEarly, bestMetrics, mode) < 0){
            bestMetrics = { ...resInterDayEarly };
            saveBestSnapshot();
            improvedInRound = true;
          }
          const resBlockShiftEarly = this.tryBlockShiftAndGapResolution(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resBlockShiftEarly && this.compareMetrics(resBlockShiftEarly, bestMetrics, mode) < 0){
            bestMetrics = { ...resBlockShiftEarly };
            saveBestSnapshot();
            improvedInRound = true;
          }
          const resChainEarly = this.tryIntraSessionCrossClassChain(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resChainEarly && this.compareMetrics(resChainEarly, bestMetrics, mode) < 0){
            bestMetrics = { ...resChainEarly };
            saveBestSnapshot();
            improvedInRound = true;
          }
          }

          // 1. Forward Gap Crusher
          // 0a. Dissolve thin gap sessions (y tuong chu du an: tach tiet dap vao
          // buoi khac dang ton tai, khong hinh thanh buoi moi)
          const resDissolve = this.tryDissolveGapSession(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resDissolve && this.compareMetrics(resDissolve, bestMetrics, mode) < 0){
            bestMetrics = { ...resDissolve };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 0. Relabel ejection cycles (nuoc di chu luc hoc tu tham chieu)
          const resCycle = this.tryGapRelabelCycles(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resCycle && this.compareMetrics(resCycle, bestMetrics, mode) < 0){
            bestMetrics = { ...resCycle };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const resGap = this.tryCrushTeacherGaps(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resGap && this.compareMetrics(resGap, bestMetrics, mode) < 0){
            bestMetrics = { ...resGap };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 2. Inbound Gap-Filler (De Xuat 3)
          const resFill = this.tryFillTeacherGapFromElsewhere(bestMetrics, initialMetrics, notifyLiveProgress);
          if(resFill && this.compareMetrics(resFill, bestMetrics, mode) < 0){
            bestMetrics = { ...resFill };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 3. Double Block Gap-Filler (De Xuat 4)
          const resDouble = this.tryMoveDoubleBlockIntoGap(bestMetrics, initialMetrics, notifyLiveProgress);
          if(resDouble && this.compareMetrics(resDouble, bestMetrics, mode) < 0){
            bestMetrics = { ...resDouble };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 3b. Eject-place: ép tiết biên vào lỗ bằng recursive swapping (FET)
          const resEject = this.tryEjectPlaceIntoGap(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resEject && this.compareMetrics(resEject, bestMetrics, mode) < 0){
            bestMetrics = { ...resEject };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 3c. Buổi mới (nới lỏng 17/08): dời trọn buổi gap2 kẹt sang nửa-ngày
          // giáo viên đang trống — cả cụm đi cùng nhau, không sinh buổi 1 tiết.
          const resReloc = this.tryRelocateGapSessionToNewDay(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resReloc && this.compareMetrics(resReloc, bestMetrics, mode) < 0){
            bestMetrics = { ...resReloc };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 3d. Ghép tiết lẻ vào lỗ (vế 1 hướng 17/08): kéo nguyên buổi mỏng /
          // cặp tiết mép về lấp >=2 lỗ CÙNG LÚC — nước ghép mà từng bước lẻ
          // không qua nổi gate ([1,5] lấp 1 lỗ vẫn là gap2).
          const resMerge = this.tryMergeSessionIntoGaps(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resMerge && this.compareMetrics(resMerge, bestMetrics, mode) < 0){
            bestMetrics = { ...resMerge };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 3e. Chuỗi Kempe hoán đổi 2 tiết trong buổi — nước phẫu thuật khi
          // kinh tế ô lớp bão hòa (mọi eject đều dồn gap sang người khác).
          const resKempe = this.tryKempeChainPeriodSwap(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resKempe && this.compareMetrics(resKempe, bestMetrics, mode) < 0){
            bestMetrics = { ...resKempe };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 3f. Đày tiết mép đi nơi khác bất kỳ (17/08: 1t khóa, còn lại tự do)
          const resExile = this.tryExileEdgeLesson(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resExile && this.compareMetrics(resExile, bestMetrics, mode) < 0){
            bestMetrics = { ...resExile };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 3f. Intra-Session Cross-Class Chain & 3-Cycle (Toi uu triet de gap2 khong sinh 1-tiet/buoi)
          const resChain2 = this.tryIntraSessionCrossClassChain(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resChain2 && this.compareMetrics(resChain2, bestMetrics, mode) < 0){
            bestMetrics = { ...resChain2 };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 4. Expanded Vacate on sessions with hasGap2 (De Xuat 1 + 5: bo idx.length <= 2, tang mau len 15-20 GV)
          const gapTeachers = [];
          this.teacherGrid.forEach((grid, tKey) => {
            if(!tKey || !this.isScoredTeacher(tKey)) return;
            const tm = this.evaluateTeacherMetrics(tKey);
            if(tm.soBuoiTrong2 > 0) gapTeachers.push(tKey);
          });
          if(gapTeachers.length > 0){
            this.rng.shuffle(gapTeachers);
            for(const tKey of gapTeachers.slice(0, 15)){
              for(let d = 0; d < DAYS_LIST.length; d++){
                for(let b = 0; b < SESSIONS_LIST.length; b++){
                  const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
                  const tGrid = this.teacherGrid.get(tKey);
                  let hasGap2 = false;
                  const idx = [];
                  for(let p = 0; p < PERIODS_PER_SESSION; p++){
                    if(tGrid[sStart + p] >= 0 || tGrid[sStart + p] === -3) idx.push(p);
                  }
                  if(idx.length >= 2){
                    // Span rule (khop UI): tong so lo trong buoi >= 2
                    const holes = (idx[idx.length - 1] - idx[0] + 1) - idx.length;
                    if(holes >= 2) hasGap2 = true;
                  }
                  if(hasGap2){
                    const resV = this.tryVacateTeacherSession(tKey, d, b, bestMetrics, initialMetrics, mode);
                    if(resV && this.compareMetrics(resV, bestMetrics, mode) < 0){
                      bestMetrics = { ...resV };
                      saveBestSnapshot();
                      improvedInRound = true;
                      break;
                    }
                  }
                }
                if(improvedInRound) break;
              }
              if(improvedInRound) break;
            }
          }
        }

        if(mode === "optimize_gap1"){
          const resCycle1 = this.tryGapRelabelCycles(bestMetrics, initialMetrics, "optimize_gap1", notifyLiveProgress);
          if(resCycle1 && this.compareMetrics(resCycle1, bestMetrics, mode) < 0){
            bestMetrics = { ...resCycle1 };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const resGap = this.tryCrushTeacherGaps(bestMetrics, initialMetrics, "optimize_gap1", notifyLiveProgress);
          if(resGap && this.compareMetrics(resGap, bestMetrics, mode) < 0){
            bestMetrics = { ...resGap };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const resEject1 = this.tryEjectPlaceIntoGap(bestMetrics, initialMetrics, "optimize_gap1", notifyLiveProgress);
          if(resEject1 && this.compareMetrics(resEject1, bestMetrics, mode) < 0){
            bestMetrics = { ...resEject1 };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const resReloc1 = this.tryRelocateGapSessionToNewDay(bestMetrics, initialMetrics, "optimize_gap1", notifyLiveProgress);
          const resBorrow1 = this.tryBorrowLessonFromRichSessions(bestMetrics, initialMetrics, "optimize_gap1", notifyLiveProgress);
          if(resBorrow1 && this.compareMetrics(resBorrow1, bestMetrics, mode) < 0){
            bestMetrics = { ...resBorrow1 };
            saveBestSnapshot();
            improvedInRound = true;
          }
          if(resReloc1 && this.compareMetrics(resReloc1, bestMetrics, mode) < 0){
            bestMetrics = { ...resReloc1 };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const resKempe1 = this.tryKempeChainPeriodSwap(bestMetrics, initialMetrics, "optimize_gap1", notifyLiveProgress);
          if(resKempe1 && this.compareMetrics(resKempe1, bestMetrics, mode) < 0){
            bestMetrics = { ...resKempe1 };
            saveBestSnapshot();
            improvedInRound = true;
          }
        }

        // =========================================================================
        // 2. MULTI-DIRECTIONAL ESCAPE ARCHITECTURE (KHI BỊ ĐỨNG / STAGNATION ESCAPE)
        // =========================================================================
        if(!improvedInRound){
          consecutiveUnimprovedRounds++;

          // Identify current bottleneck teachers
          const bottleneckTeachers = [];
          this.teacherGrid.forEach((grid, tKey) => {
            if(!tKey || !this.isScoredTeacher(tKey)) return;
            const tm = this.evaluateTeacherMetrics(tKey);
            if((mode === "optimize_singletons" && tm.soBuoiDay1 > 0) ||
               (mode === "optimize_sessions" && (tm.tsBuoiDay >= 4 || tm.soBuoiDay2 > 0 || tm.soBuoiDay3 > 0)) ||
               (mode === "optimize_gap2" && tm.soBuoiTrong2 > 0) ||
               (mode === "optimize_gap1" && tm.soBuoiTrong1 > 0)){
              bottleneckTeachers.push(tKey);
            }
          });
          this.rng.shuffle(bottleneckTeachers);

          // ESCAPE DIRECTION A: Whole-Session Block Swaps (Hoán đổi cụm buổi của lớp)
          if(consecutiveUnimprovedRounds % 4 === 1){
            const resBlock = this.tryWholeSessionSwap(bestMetrics, mode, notifyLiveProgress);
            if(resBlock && this.compareMetrics(resBlock, bestMetrics, mode) < 0){
              bestMetrics = { ...resBlock };
              saveBestSnapshot();
              improvedInRound = true;
              consecutiveUnimprovedRounds = 0;
            }
          }

          // ESCAPE DIRECTION B: Deep 4-Way Ejection Chains (Chuỗi đẩy liên hoàn 4 cấp)
          if(!improvedInRound && (consecutiveUnimprovedRounds % 4 === 2 || consecutiveUnimprovedRounds >= 5)){
            if(bottleneckTeachers.length > 0){
              const resChain = this.tryDeepEjectionChain(bottleneckTeachers.slice(0, 5), bestMetrics, mode, notifyLiveProgress);
              if(resChain && this.compareMetrics(resChain, bestMetrics, mode) < 0){
                bestMetrics = { ...resChain };
                saveBestSnapshot();
                improvedInRound = true;
                consecutiveUnimprovedRounds = 0;
              }
            }
          }

          // ESCAPE DIRECTION B2 (toan tu tu phien song song, demote 17/08): random-swap
          // ejection cho tung actId le cua GV nghen. Do ton budget (12000 calls/act),
          // CHI chay khi ket sau (>=6 vong khong cai thien) de khong lam cham pha nong.
          if(!improvedInRound && consecutiveUnimprovedRounds >= 6 && bottleneckTeachers.length > 0){
            const resSing = this.trySingletonEjectionChain(bottleneckTeachers.slice(0, 8), bestMetrics, mode, notifyLiveProgress);
            if(resSing && this.compareMetrics(resSing, bestMetrics, mode) < 0){
              bestMetrics = { ...resSing };
              saveBestSnapshot();
              improvedInRound = true;
              consecutiveUnimprovedRounds = 0;
            }
          }

          // ESCAPE DIRECTION C: Related-Cluster Ruin & Recreate (Phá bỏ & Tái cấu trúc cụm liên đới)
          if(!improvedInRound && (consecutiveUnimprovedRounds % 4 === 3 || consecutiveUnimprovedRounds >= 6)){
            if(bottleneckTeachers.length > 0){
              const resCluster = this.tryRelatedClusterRuin(bottleneckTeachers.slice(0, 4), bestMetrics, mode, 0, notifyLiveProgress);
              if(resCluster && this.compareMetrics(resCluster, bestMetrics, mode) < 0){
                bestMetrics = { ...resCluster };
                saveBestSnapshot();
                improvedInRound = true;
                consecutiveUnimprovedRounds = 0;
              }
            }
          }

          // ESCAPE DIRECTION D: Neutral Plateau Random Walk (Bước đi ngang trên yên ngựa)
          if(!improvedInRound && consecutiveUnimprovedRounds >= 4 && consecutiveUnimprovedRounds % 3 === 0){
            const resWalk = this.tryNeutralPlateauWalk(12, bestMetrics, mode, notifyLiveProgress);
            if(resWalk && this.compareMetrics(resWalk, bestMetrics, mode) < 0){
              bestMetrics = { ...resWalk };
              saveBestSnapshot();
              improvedInRound = true;
              consecutiveUnimprovedRounds = 0;
            }
          }

          // ESCAPE DIRECTION E: Elite Archive Branching (Đổi sang nhánh tinh hoa khác khi bế tắc sâu)
          if(!improvedInRound && consecutiveUnimprovedRounds >= 10 && eliteArchive.length > 1){
            const altElite = eliteArchive[Math.floor(this.rng.next() * eliteArchive.length)];
            if(altElite){
              this.actPlacement = altElite.placement.slice();
              this.classGrid = new Map(Array.from(altElite.classGrid.entries()).map(([k, v]) => [k, v.slice()]));
              this.teacherGrid = new Map(Array.from(altElite.teacherGrid.entries()).map(([k, v]) => [k, v.slice()]));
              this.roomGrid = new Map(Array.from(altElite.roomGrid.entries()).map(([k, v]) => [k, v.slice()]));
              this.tryNeutralPlateauWalk(8, bestMetrics, mode, notifyLiveProgress);
            }
          }
        }else{
          consecutiveUnimprovedRounds = 0;
        }

        const pct = Math.min(99, Math.round(((round + 1) / MAX_ROUNDS) * 100));
        if(progressCallback){
          const shownM = (this.__globalBestM && this.compareMetrics(this.__globalBestM, bestMetrics, mode) < 0) ? this.__globalBestM : bestMetrics;
          progressCallback({
            percent: pct,
            currentMetric: getMetricVal(shownM),
            initialMetric: getMetricVal(initialMetrics),
            metrics: shownM
          });
        }

        if(mode === "optimize_singletons" && bestMetrics.soBuoiDay1 <= 0){
          if(progressCallback){
            progressCallback({
              percent: 100,
              currentMetric: bestMetrics.soBuoiDay1,
              initialMetric: Math.max(1, getMetricVal(initialMetrics)),
              metrics: bestMetrics
            });
          }
          break;
        }

        if(getMetricVal(bestMetrics) === 0){
          if(progressCallback){
            progressCallback({
              percent: 100,
              currentMetric: getMetricVal(bestMetrics),
              initialMetric: Math.max(1, getMetricVal(initialMetrics)),
              metrics: bestMetrics
            });
          }
          break;
        }

        if(consecutiveUnimprovedRounds >= maxStagnantRounds){
          break; // khung 100% phát sau khi portfolio kết thúc thật sự
        }
      }

      // Quyết định restart: global best còn chỉ tiêu > 0, còn ngân sách thời
      // gian, chưa bị Dừng. Lượt LẺ đi lại TỪ GỐC với pha RNG mới (đa dạng hóa
      // — mỗi pha mở được các ca kẹt khác nhau), lượt CHẴN đi tiếp từ global
      // best (thâm canh). Kết quả cuối luôn là global best qua mọi lượt.
      const globalVal = this.__globalBestM ? getMetricVal(this.__globalBestM) : getMetricVal(bestMetrics);
      if(canRestart && globalVal > restartTargetVal && restartCount < maxRestarts &&
         (Date.now() - optStartMs) < Math.min(restartBudgetMs, hardCapMs) &&
         !(typeof window !== "undefined" && window.__AUTO_SORT_STOP_REQUESTED) &&
         !(this.stageDeadlineMs && Date.now() > this.stageDeadlineMs)){
        restartCount++;
        const diversify = (restartCount % 2 === 1);
        const src = (diversify || !this.__globalBestSnap) ? initialStateSnap : this.__globalBestSnap;
        this.restoreStateSnapshot(src);
        if(diversify){
          // ILS: lay chuyển trạng thái bằng các nước đi HỢP LỆ ngẫu nhiên trước
          // khi đổ dốc lại — bắt buộc khi "gốc" đã chính là một cực tiểu cục bộ
          // (trường hợp bước quét chốt của optimizeAll); không lay thì mọi
          // restart đều rơi lại đúng một lòng chảo và kẹt trong vài giây.
          this.perturbForRestart(6 + restartCount * 3);
        }
        bestMetrics = { ...this.evaluateMetrics() };
        bestPlacement = this.actPlacement.slice();
        bestClassGrid = new Map(Array.from(this.classGrid.entries()).map(([k, v]) => [k, v.slice()]));
        bestTeacherGrid = new Map(Array.from(this.teacherGrid.entries()).map(([k, v]) => [k, v.slice()]));
        bestRoomGrid = new Map(Array.from(this.roomGrid.entries()).map(([k, v]) => [k, v.slice()]));
        consecutiveUnimprovedRounds = 0;
        destroyStrength = 1;
        const spin = 97 + restartCount * 31;
        for(let i = 0; i < spin; i++) this.rng.next(); // xoay pha ngẫu nhiên
        portfolioDone = false;
      }
      } // while portfolio
      this.__lastRestartCount = restartCount; // chẩn đoán

      // Chốt: khôi phục GLOBAL BEST (nếu có) làm kết quả cuối.
      if(this.__globalBestSnap){
        bestPlacement = this.__globalBestSnap.placement;
        bestClassGrid = this.__globalBestSnap.classGrid;
        bestTeacherGrid = this.__globalBestSnap.teacherGrid;
        bestRoomGrid = this.__globalBestSnap.roomGrid;
        bestMetrics = { ...this.__globalBestM };
      }
      this.checkpointGuard = null;
      this.__globalBestSnap = null;
      this.__globalBestM = null;
      this.opDeadlineMs = 0;

      if(progressCallback){
        progressCallback({
          percent: 100,
          currentMetric: getMetricVal(bestMetrics),
          initialMetric: Math.max(1, getMetricVal(initialMetrics)),
          metrics: bestMetrics
        });
      }

      if(bestPlacement){
        this.actPlacement = bestPlacement;
        this.classGrid = bestClassGrid;
        this.teacherGrid = bestTeacherGrid;
        this.roomGrid = bestRoomGrid;
      }

      // PHÒNG THỦ CUỐI: trạng thái trả về BẮT BUỘC nguyên vẹn và không tệ hơn
      // lúc bấm nút (theo đúng thước đo của mode). Đường hỏng nào lọt tới đây
      // → trả nguyên trạng ban đầu.
      if(!this.verifyPlacementIntegrity() || this.compareMetrics(this.evaluateMetrics(), initialMetrics, mode) > 0){
        this.restoreStateSnapshot(initialStateSnap);
        bestMetrics = { ...initialMetrics };
      }

      this.applyToDataTKB();

      let placed = 0;
      this.activities.forEach((act, idx) => {
        if(this.actPlacement[idx] >= 0) placed += act.duration;
      });
      placed += this.fixedSlots.size;

      return {
        ok: true,
        placed,
        unassigned: 0,
        initialMetrics,
        metrics: bestMetrics,
        residualSingletons: this.getResidualSingletons(),
        residualGap2: this.getResidualGap2Sessions()
      };
    }

    // =========================================================================
    // GAP2 VỚI CƠ CHẾ "VAY-TRẢ" 1 TIẾT/BUỔI (đột phá 17/08)
    // Bằng chứng thực nghiệm trên bản 0917: 4 ca trống-2 "bất khả" với mọi chuỗi
    // đơn (probe 30 pha x 200k bước/nước) — nhưng nếu MƯỢN TẠM 1 suất 1t/buổi
    // thì 2 ca chết ngay. Gate tham lam không bao giờ dám bước qua thung lũng
    // s1+1; cơ chế này bước hộ: [vay] gap2 với trần s1+1 → [trả] pha 1t/buổi
    // → [quét] gap2 chốt không vay. CHỈ NHẬN kết quả nếu tuple cuối tốt hơn
    // phương án không-vay VÀ s1 cuối <= s1 lúc bấm nút; ngược lại trả nguyên
    // phương án không-vay. Không bao giờ tệ hơn hành vi cũ.
    // =========================================================================
    