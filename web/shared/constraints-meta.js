(function(){
  "use strict";

  window.TKBConstraintsMeta = {
    TEACHER_RULES: [
      ["maxDaysSessions", "Giới hạn số ngày dạy & buổi dạy/1 tuần"],
      ["maxPeriods", "Giới hạn số tiết dạy/1 buổi"],
      ["maxMorningAfternoon", "Giới hạn số buổi dạy sáng & chiều"],
      ["oneSessionPerDay", "Chỉ dạy 1 buổi/1 ngày"],
      ["noMorningP5AfternoonP1", "Không dạy tiết 5 buổi sáng & tiết 1 buổi chiều"],
      ["oneLocationPerSession", "Chỉ dạy 1 địa điểm/1 buổi"],
      ["gapBetweenLocations", "Có tiết trống giữa 2 địa điểm"],
      ["maxOneMovePerSession", "Không di chuyển 2 lần/1 buổi giữa các địa điểm"],
      ["mustTeach", "Vị trí phải có tiết dạy"]
    ],
    SUBJECT_RULES: [
      ["lessonBlocks", "Số buổi học có tiết học xếp liền"],
      ["avoidBreakPair23", "Tránh xếp 2 tiết liền qua tiết 2-3"],
      ["avoidBreakPair34", "Tránh xếp 2 tiết liền qua tiết 3-4"],
      ["linkedDays", "Tránh xếp tiết học xếp liền vào các thứ trong tuần"],
      ["sessionAllowed", "Giới hạn buổi của môn học"],
      ["weeklySessionPeriods", "Giới hạn số tiết của môn học/1 buổi/1 tuần"],
      ["spacingDays", "Học cách ngày"],
      ["maxPeriods", "Giới hạn số tiết/1 buổi"],
      ["maxPeriodsDay", "Giới hạn số tiết/1 ngày"],
      ["noSameSession", "Môn học không cùng buổi"],
      ["noSameDay", "Môn học không cùng ngày"],
      ["maxSessions", "Giới hạn số buổi học"]
    ],
    FIXED_OFF_GROUP_LABEL: "Yêu cầu cố định",
    FIXED_OFF_TYPES: [
      ["class", "Yêu cầu cố định lớp học"],
      ["teacher", "Yêu cầu cố định giáo viên"],
      ["subject", "Yêu cầu cố định môn học"]
    ]
  };
})();
