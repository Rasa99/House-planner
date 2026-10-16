;;; dev/dxf-acad.lsp  (drafting agent, House Planner)
;;; Loaded by dev/dxf-acad.ps1 inside AutoCAD's headless console (through
;;; AutoCAD Tools\Run-Headless.ps1 - never accoreconsole directly).
;;; The script OPENs a House Planner DXF (what Rasa does; hp:check can also
;;; DXFIN one into the template), runs AUDIT, and prints what AutoCAD holds: entities by type, every hatch (pattern,
;;; lines, loops, area), every dimension (its block and the text in it), the
;;; layers, the HP dimstyle, linetypes, the text style, and "m2" text.
;;; Then makes AutoCAD rebuild two dimensions from the HP dimstyle (DIMEDIT
;;; Home) and prints the text it draws, so the dimstyle is proven too.
;;; Every line of the report starts with HP so the wrapper can pick it out.

(defun hp:add (k al / a)
  (if (setq a (assoc k al))
    (subst (cons k (1+ (cdr a))) a al)
    (cons (cons k 1) al)))

(defun hp:val (code ed / a) (if (setq a (assoc code ed)) (cdr a)))

(defun hp:str (v)
  (cond ((null v) "nil")
        ((= (type v) 'STR) v)
        ((= (type v) 'INT) (itoa v))
        ((= (type v) 'REAL) (rtos v 2 6))
        (T (vl-prin1-to-string v))))

;; entities of a block definition -> (types texts lineCount)
(defun hp:block (name / en ed types texts nl)
  (setq en (tblobjname "BLOCK" name) types nil texts nil nl 0)
  (if en
    (while (setq en (entnext en))
      (setq ed (entget en)
            types (hp:add (hp:val 0 ed) types))
      (if (= (hp:val 0 ed) "LINE") (setq nl (1+ nl)))
      (if (member (hp:val 0 ed) '("TEXT" "MTEXT"))
        (setq texts (cons (strcat (hp:val 1 ed) "@" (rtos (hp:val 40 ed) 2 4)) texts)))))
  (list types texts nl))

(defun hp:area (en / a)
  (setq a (vl-catch-all-apply 'vl-cmdf (list "_.AREA" "_O" en)))
  (if (vl-catch-all-error-p a) "n/a" (rtos (getvar "AREA") 2 6)))

;; dxf = nil: the DXF is already the open drawing (the script OPENed it - what
;; Rasa does). A path: bring it into the current drawing with DXFIN instead
;; (DXFIN keeps the template's header, so INSUNITS etc. then say nothing).
(defun hp:check (dxf / ss i en ed typ types sq dims small big b txt lay L)
  (setvar "FILEDIA" 0)
  (setvar "CMDECHO" 0)
  (if dxf
    (progn (princ (strcat "\nHPSTEP dxfin " dxf)) (command "_.DXFIN" dxf))
    (princ (strcat "\nHPSTEP opened " (getvar "DWGPREFIX") (getvar "DWGNAME"))))
  (command "_.ZOOM" "_E")
  (princ "\nHPSTEP audit")
  (setvar "CMDECHO" 1)
  (command "_.AUDIT" "_Y")
  (setvar "CMDECHO" 0)
  (princ "\nHPSTEP report")
  (princ (strcat "\nHPUNITS INSUNITS=" (itoa (getvar "INSUNITS")) " MEASUREMENT=" (itoa (getvar "MEASUREMENT"))
                 " DIMSTYLE=" (getvar "DIMSTYLE") " TEXTSTYLE=" (getvar "TEXTSTYLE") " LTSCALE=" (hp:str (getvar "LTSCALE"))
                 " EXTMIN=" (hp:str (getvar "EXTMIN")) " EXTMAX=" (hp:str (getvar "EXTMAX"))))
  ;; ---- model space
  (setq ss (ssget "X" '((410 . "Model"))) types nil sq 0 dims nil)
  (if ss
    (repeat (setq i (sslength ss))
      (setq en (ssname ss (setq i (1- i))) ed (entget en) typ (hp:val 0 ed) types (hp:add typ types))
      (cond
        ((= typ "HATCH")
         (princ (strcat "\nHPHATCH pattern=" (hp:val 2 ed) " layer=" (hp:val 8 ed)
                        " solid=" (hp:str (hp:val 70 ed)) " assoc=" (hp:str (hp:val 71 ed))
                        " loops=" (hp:str (hp:val 91 ed)) " patlines=" (hp:str (hp:val 78 ed))
                        " scale=" (hp:str (hp:val 41 ed)) " area=" (hp:area en))))
        ((= typ "DIMENSION")
         (setq b (hp:block (hp:val 2 ed)) dims (cons en dims))
         (princ (strcat "\nHPDIM block=" (hp:val 2 ed) " style=" (hp:val 3 ed) " layer=" (hp:val 8 ed)
                        " measure=" (hp:str (hp:val 42 ed)) " lines=" (itoa (nth 2 b))
                        " text=" (hp:str (nth 1 b)) " ents=" (hp:str (nth 0 b)))))
        ((= typ "TEXT")
         (setq txt (hp:val 1 ed))
         (if (vl-string-search (chr 178) txt) (setq sq (1+ sq))))
        ((= typ "INSERT")
         (setq b (hp:block (hp:val 2 ed)))
         (princ (strcat "\nHPINSERT block=" (hp:val 2 ed) " layer=" (hp:val 8 ed) " ents=" (hp:str (nth 0 b)))))
      )))
  (princ (strcat "\nHPCOUNT " (vl-prin1-to-string types)))
  (princ (strcat "\nHPSQUARE texts-with-superscript-2=" (itoa sq)))
  ;; ---- tables
  (foreach lay '("A-WALL" "A-WALL-PATT" "A-DOOR" "A-GLAZ" "A-FURN" "A-FIXT" "A-ANNO-TEXT" "A-ANNO-DIMS" "A-SECT" "A-PLOT" "A-ROAD" "A-OPEN-PATT" "A-SITE-PATT")
    (if (setq L (tblobjname "LAYER" lay))
      (progn (setq L (entget L))
             (princ (strcat "\nHPLAYER " lay " aci=" (hp:str (hp:val 62 L)) " true=" (hp:str (hp:val 420 L))
                            " ltype=" (hp:str (hp:val 6 L)) " lw=" (hp:str (hp:val 370 L)))))
      (princ (strcat "\nHPLAYER " lay " MISSING"))))
  (if (setq L (tblsearch "DIMSTYLE" "HP"))
    (princ (strcat "\nHPDIMSTYLE HP DIMTSZ=" (hp:str (hp:val 142 L)) " DIMTXT=" (hp:str (hp:val 140 L))
                   " DIMDEC=" (hp:str (hp:val 271 L)) " DIMLFAC=" (hp:str (hp:val 144 L)) " DIMZIN=" (hp:str (hp:val 78 L))
                   " DIMCLRD=" (hp:str (hp:val 176 L)) " DIMCLRT=" (hp:str (hp:val 178 L)) " DIMTAD=" (hp:str (hp:val 77 L))
                   " DIMEXO=" (hp:str (hp:val 42 L)) " DIMEXE=" (hp:str (hp:val 44 L)) " DIMGAP=" (hp:str (hp:val 147 L))))
    (princ "\nHPDIMSTYLE HP MISSING"))
  (foreach lay '("DASHED" "DASHDOT")
    (if (setq L (tblsearch "LTYPE" lay))
      (princ (strcat "\nHPLTYPE " lay " length=" (hp:str (hp:val 40 L)) " parts=" (hp:str (hp:val 73 L))))
      (princ (strcat "\nHPLTYPE " lay " MISSING"))))
  (if (setq L (tblsearch "STYLE" "HP"))
    (princ (strcat "\nHPSTYLE HP font=" (hp:str (hp:val 3 L))))
    (princ "\nHPSTYLE HP MISSING"))
  ;; ---- let AutoCAD rebuild dimensions from the HP dimstyle and say what it draws
  (setq small nil big nil)
  (foreach en dims
    (setq ed (entget en (list "ACAD")))
    (if (and (null small) (assoc -3 ed)) (setq small en))
    (if (and (null big) (null (assoc -3 ed))) (setq big en)))
  (foreach en (vl-remove nil (list big small))
    (vl-cmdf "_.DIMEDIT" "_H" en "")
    (setq ed (entget en) b (hp:block (hp:val 2 ed)))
    (princ (strcat "\nHPREBUILT block=" (hp:val 2 ed) " measure=" (hp:str (hp:val 42 ed))
                   " lines=" (itoa (nth 2 b)) " text=" (hp:str (nth 1 b)) " ents=" (hp:str (nth 0 b)))))
  (princ "\nHPDONE")
  (princ))
